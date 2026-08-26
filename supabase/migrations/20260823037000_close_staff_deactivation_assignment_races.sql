-- Forward-only closeout for staff deactivation/assignment races.
--
-- Booking and segment writes already own their row before a row trigger runs.
-- They therefore take the referenced staff row FOR UPDATE next. The public
-- offboarding RPC now pre-locks every affected parent/segment in deterministic
-- order before its existing implementation locks the departing staff row.
-- Direct staff deactivation/deletion only scans and rejects live references;
-- it deliberately does not lock booking rows, which would invert that order.

CREATE OR REPLACE FUNCTION public.enforce_active_staff_for_live_booking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $active_staff$
DECLARE
  v_staff_salon_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN
    IF NEW.schedule_model <> 'single'
       OR NEW.status IN ('cancelled','no_show','completed')
       OR NEW.staff_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.reservation_status IN ('cancelled','no_show','completed') THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT st.salon_id INTO v_staff_salon_id
  FROM public.staff st
  WHERE st.id = NEW.staff_id
    AND st.status = 'active'
    AND st.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR v_staff_salon_id IS DISTINCT FROM NEW.salon_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'live booking requires active same-salon staff';
  END IF;
  RETURN NEW;
END;
$active_staff$;

REVOKE ALL ON FUNCTION public.enforce_active_staff_for_live_booking()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.enforce_no_live_assignments_on_staff_deactivation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $staff_deactivation$
DECLARE
  v_staff_id uuid:=OLD.id;
  v_salon_id uuid:=OLD.salon_id;
BEGIN
  IF TG_OP='UPDATE' AND NOT (
    (NEW.status='inactive' AND NEW.status IS DISTINCT FROM OLD.status)
    OR (
      NEW.deleted_at IS NOT NULL
      AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    )
  ) THEN
    RETURN NEW;
  END IF;

  -- Do not take booking/segment row locks here. The staff row is already
  -- update-locked by this statement. A concurrent assignment waits on that
  -- row in enforce_active_staff_for_live_booking() and rechecks after commit.
  IF EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.salon_id=v_salon_id
      AND b.staff_id=v_staff_id
      AND b.deleted_at IS NULL
      AND b.status IN ('pending','confirmed','in_progress','waiting')
  ) OR EXISTS (
    SELECT 1
    FROM public.booking_service_segments seg
    WHERE seg.salon_id=v_salon_id
      AND seg.staff_id=v_staff_id
      AND seg.reservation_status IN ('pending','confirmed','in_progress','waiting')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE='staff with live bookings must be offboarded atomically';
  END IF;

  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$staff_deactivation$;

REVOKE ALL ON FUNCTION public.enforce_no_live_assignments_on_staff_deactivation()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER enforce_no_live_assignments_before_staff_deactivation
  BEFORE UPDATE OF status,deleted_at OR DELETE
  ON public.staff
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_no_live_assignments_on_staff_deactivation();

-- Preserve the already-applied v3 behavior as an internal implementation.
-- The new externally callable function below establishes booking -> segment ->
-- staff lock order before entering it.
ALTER FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) RENAME TO offboard_staff_with_durable_notifications_v3_impl;

-- Candidate rows must use the same exclusive row-lock strength as every other
-- live-assignment validation. This is a forward repair of the v3 definition.
DO $candidate_lock$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.offboard_staff_with_durable_notifications_v3_impl(uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer)'::regprocedure
  ) INTO v_definition;
  IF pg_catalog.strpos(v_definition,'ORDER BY s.id FOR KEY SHARE;')=0 THEN
    RAISE EXCEPTION 'staff offboarding v3 candidate lock signature changed';
  END IF;
  v_definition:=pg_catalog.replace(
    v_definition,
    'ORDER BY s.id FOR KEY SHARE;',
    'ORDER BY s.id FOR UPDATE;'
  );
  EXECUTE v_definition;
END;
$candidate_lock$;

REVOKE ALL ON FUNCTION public.offboard_staff_with_durable_notifications_v3_impl(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.offboard_staff_with_durable_notifications(
  p_salon_id uuid,p_staff_id uuid,p_request_id uuid,p_actor_user_id uuid,
  p_actor_role text,p_assignments jsonb,p_notify_email boolean,p_notify_sms boolean,
  p_revoke_access boolean,p_notification_delay_seconds integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $locked_offboard$
DECLARE
  v_affected_booking_ids uuid[]:='{}'::uuid[];
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN pg_catalog.jsonb_build_object('success',false,'code','unauthorized');
  END IF;

  -- Let the internal implementation return the canonical invalid-input result
  -- without evaluating lock keys from null identifiers.
  IF p_salon_id IS NULL OR p_staff_id IS NULL THEN
    RETURN public.offboard_staff_with_durable_notifications_v3_impl(
      p_salon_id,p_staff_id,p_request_id,p_actor_user_id,p_actor_role,
      p_assignments,p_notify_email,p_notify_sms,p_revoke_access,
      p_notification_delay_seconds
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'staff-offboarding:'||p_salon_id::text,0
  ));

  SELECT coalesce(pg_catalog.array_agg(b.id ORDER BY b.id),'{}'::uuid[])
  INTO v_affected_booking_ids
  FROM public.bookings b
  WHERE b.salon_id=p_salon_id
    AND b.deleted_at IS NULL
    AND b.status IN ('pending','confirmed','in_progress','waiting')
    AND (
      b.staff_id=p_staff_id
      OR EXISTS (
        SELECT 1
        FROM public.booking_service_segments seg
        WHERE seg.booking_id=b.id
          AND seg.salon_id=p_salon_id
          AND seg.staff_id=p_staff_id
          AND seg.reservation_status IN (
            'pending','confirmed','in_progress','waiting'
          )
      )
    );

  PERFORM 1
  FROM public.bookings b
  WHERE b.id=ANY(v_affected_booking_ids)
  ORDER BY b.id
  FOR UPDATE;
  PERFORM 1
  FROM public.booking_service_segments seg
  WHERE seg.booking_id=ANY(v_affected_booking_ids)
  ORDER BY seg.booking_id,seg.position,seg.id
  FOR UPDATE;

  RETURN public.offboard_staff_with_durable_notifications_v3_impl(
    p_salon_id,p_staff_id,p_request_id,p_actor_user_id,p_actor_role,
    p_assignments,p_notify_email,p_notify_sms,p_revoke_access,
    p_notification_delay_seconds
  );
END;
$locked_offboard$;

REVOKE ALL ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) TO service_role;

COMMENT ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) IS 'Service-role-only atomic staff offboarding entry point. Locks affected booking parents and segments before staff rows, then delegates to the durable v3 implementation. Queues notification work only; it never calls a provider.';
