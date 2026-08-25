-- NailIQ V1 keeps cancelled/no-show rows as terminal history. Linked archived
-- recovery and long-lived restore/undo move to Phase 2. The one V1 correction
-- is an eight-second undo of a just-cancelled booking, executed by a scoped RPC.
--
-- The trigger is also the acceptance-critical audit boundary: every terminal
-- status transition writes its audit row in the same database transaction as
-- the booking update. Provider/payment fields are deliberately outside the
-- immutable identity/schedule tuple and remain governed by their dedicated
-- service workflows.

CREATE OR REPLACE FUNCTION public.enforce_v1_terminal_booking_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_actor_user_id uuid;
  v_actor_role text;
  v_actor_setting text := nullif(
    current_setting('nailiq.v1_terminal_actor_user_id', true),
    ''
  );
  v_reason text := coalesce(
    nullif(current_setting('nailiq.v1_terminal_reason', true), ''),
    CASE
      WHEN tg_op = 'UPDATE' AND new.status = 'cancelled' THEN 'terminal_cancel'
      WHEN tg_op = 'UPDATE' AND new.status = 'no_show' THEN 'terminal_no_show'
      ELSE 'terminal_status_change'
    END
  );
  v_undo_scope text := coalesce(
    current_setting('nailiq.v1_terminal_undo_booking_id', true),
    ''
  );
BEGIN
  IF tg_op = 'INSERT' THEN
    IF new.recovered_from_booking_id IS NOT NULL
       OR new.recovery_kind IS NOT NULL
       OR new.recovered_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'archived booking recovery is unavailable in V1'
        USING errcode = '42501';
    END IF;
    IF new.status IN ('cancelled', 'no_show')
       AND v_request_role IN ('anon', 'authenticated') THEN
      RAISE EXCEPTION 'direct terminal booking insert is not allowed'
        USING errcode = '42501';
    END IF;
    RETURN new;
  END IF;

  IF tg_op <> 'UPDATE' THEN
    RETURN new;
  END IF;

  -- No caller, including service_role, may create a linked recovery child in
  -- V1. Existing historical children may continue their ordinary lifecycle as
  -- long as the immutable recovery tuple itself is unchanged.
  IF old.recovered_from_booking_id IS NULL
     AND (
       new.recovered_from_booking_id IS NOT NULL
       OR new.recovery_kind IS NOT NULL
       OR new.recovered_by_user_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'archived booking recovery is unavailable in V1'
      USING errcode = '42501';
  END IF;

  IF old.recovered_from_booking_id IS DISTINCT FROM new.recovered_from_booking_id
     OR old.recovery_kind IS DISTINCT FROM new.recovery_kind
     OR old.recovered_by_user_id IS DISTINCT FROM new.recovered_by_user_id THEN
    RAISE EXCEPTION 'booking recovery metadata is immutable'
      USING errcode = '23514';
  END IF;

  -- A terminal row's operational identity, tenant, customer, schedule and
  -- soft-delete state are immutable in V1. No-show fee/provider receipts are
  -- intentionally not in this tuple; their dedicated workflows still own them.
  IF old.status IN ('cancelled', 'no_show') AND (
    old.salon_id IS DISTINCT FROM new.salon_id
    OR old.source IS DISTINCT FROM new.source
    OR old.booking_channel IS DISTINCT FROM new.booking_channel
    OR old.service_id IS DISTINCT FROM new.service_id
    OR old.staff_id IS DISTINCT FROM new.staff_id
    OR old.resource_id IS DISTINCT FROM new.resource_id
    OR old.group_id IS DISTINCT FROM new.group_id
    OR old.client_profile_id IS DISTINCT FROM new.client_profile_id
    OR old.client_name IS DISTINCT FROM new.client_name
    OR old.client_phone IS DISTINCT FROM new.client_phone
    OR old.client_email IS DISTINCT FROM new.client_email
    OR old.client_notes IS DISTINCT FROM new.client_notes
    OR old.start_time_utc IS DISTINCT FROM new.start_time_utc
    OR old.end_time_utc IS DISTINCT FROM new.end_time_utc
    OR old.price_cents IS DISTINCT FROM new.price_cents
    OR old.deleted_at IS DISTINCT FROM new.deleted_at
  ) THEN
    RAISE EXCEPTION 'terminal booking identity and schedule are immutable in V1'
      USING errcode = '23514';
  END IF;

  -- Long-lived restore and no-show undo are Phase 2. The only V1 exit from a
  -- terminal state is the scoped eight-second cancelled -> confirmed RPC.
  IF old.status IN ('cancelled', 'no_show')
     AND new.status IS DISTINCT FROM old.status
     AND NOT (
       old.status = 'cancelled'
       AND new.status = 'confirmed'
       AND v_undo_scope = old.id::text
     ) THEN
    RAISE EXCEPTION 'terminal booking restore is unavailable in V1'
      USING errcode = '42501';
  END IF;

  -- A caller may not combine terminal entry with an unrelated identity or
  -- schedule rewrite. This closes direct multi-column PostgREST PATCHes while
  -- preserving the existing trusted cancellation/no-show routes.
  IF old.status NOT IN ('cancelled', 'no_show')
     AND new.status IN ('cancelled', 'no_show')
     AND (
       old.salon_id IS DISTINCT FROM new.salon_id
       OR old.source IS DISTINCT FROM new.source
       OR old.booking_channel IS DISTINCT FROM new.booking_channel
       OR old.service_id IS DISTINCT FROM new.service_id
       OR old.staff_id IS DISTINCT FROM new.staff_id
       OR old.resource_id IS DISTINCT FROM new.resource_id
       OR old.group_id IS DISTINCT FROM new.group_id
       OR old.client_profile_id IS DISTINCT FROM new.client_profile_id
       OR old.client_name IS DISTINCT FROM new.client_name
       OR old.client_phone IS DISTINCT FROM new.client_phone
       OR old.client_email IS DISTINCT FROM new.client_email
       OR old.client_notes IS DISTINCT FROM new.client_notes
       OR old.start_time_utc IS DISTINCT FROM new.start_time_utc
       OR old.end_time_utc IS DISTINCT FROM new.end_time_utc
       OR old.price_cents IS DISTINCT FROM new.price_cents
       OR old.deleted_at IS DISTINCT FROM new.deleted_at
     ) THEN
    RAISE EXCEPTION 'terminal entry may not rewrite booking identity or schedule'
      USING errcode = '23514';
  END IF;

  IF old.status IS DISTINCT FROM new.status
     AND (
       new.status IN ('cancelled', 'no_show')
       OR (
         old.status = 'cancelled'
         AND new.status = 'confirmed'
         AND v_undo_scope = old.id::text
       )
     ) THEN
    IF v_actor_setting ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      v_actor_user_id := v_actor_setting::uuid;
    ELSE
      v_actor_user_id := (SELECT auth.uid());
    END IF;

    v_actor_role := nullif(
      current_setting('nailiq.v1_terminal_actor_role', true),
      ''
    );
    IF v_actor_role IS NULL AND v_actor_user_id IS NOT NULL THEN
      SELECT sm.role
        INTO v_actor_role
        FROM public.salon_members sm
       WHERE sm.salon_id = new.salon_id
         AND sm.user_id = v_actor_user_id
       LIMIT 1;
    END IF;
    v_actor_role := coalesce(v_actor_role, 'system');

    INSERT INTO public.booking_events (
      booking_id,
      salon_id,
      actor_user_id,
      actor_role,
      event_type,
      payload,
      created_at
    ) VALUES (
      new.id,
      new.salon_id,
      v_actor_user_id,
      v_actor_role,
      'terminal_booking_transition_authorized',
      jsonb_build_object(
        'from', old.status,
        'to', new.status,
        'reason', v_reason,
        'source', 'v1_terminal_booking_policy',
        'correctionWindowSeconds', CASE
          WHEN old.status = 'cancelled' AND new.status = 'confirmed' THEN 8
          ELSE NULL
        END
      ),
      pg_catalog.clock_timestamp()
    );
  END IF;

  RETURN new;
END
$function$;

COMMENT ON FUNCTION public.enforce_v1_terminal_booking_policy() IS
  'V1 default-deny recovery/restore boundary plus transaction-coupled terminal transition audit. Trigger-only; provider fee fields remain owned by dedicated workflows.';

REVOKE ALL ON FUNCTION public.enforce_v1_terminal_booking_policy()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_v1_terminal_booking_policy_trigger
  ON public.bookings;
CREATE TRIGGER enforce_v1_terminal_booking_policy_trigger
  BEFORE INSERT OR UPDATE ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_v1_terminal_booking_policy();

-- Shared service-only transition used by the receptionist actions. It repeats
-- tenant/actor/state checks and supplies exact actor/reason material to the
-- transaction-coupled trigger above. No provider is called here.
CREATE OR REPLACE FUNCTION public.transition_booking_to_terminal_v1(
  p_booking_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text,
  p_notification_request_id uuid DEFAULT NULL,
  p_notify_sms boolean DEFAULT false,
  p_notify_email boolean DEFAULT false,
  p_notification_delay_seconds integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_actual_role text;
  v_booking public.bookings%rowtype;
  v_next_status text;
  v_notification_requested boolean := coalesce(p_notify_sms, false)
    OR coalesce(p_notify_email, false);
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_booking_id IS NULL OR p_salon_id IS NULL
     OR p_reason NOT IN ('walkin_removed', 'desk_cancel', 'wix_decline', 'desk_no_show')
     OR p_notification_delay_seconds NOT BETWEEN 0 AND 120
     OR (v_notification_requested AND p_notification_request_id IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;

  IF p_actor_user_id IS NOT NULL THEN
    SELECT sm.role
      INTO v_actual_role
      FROM public.salon_members sm
     WHERE sm.salon_id = p_salon_id
       AND sm.user_id = p_actor_user_id
       AND sm.role IN ('owner', 'admin', 'senior', 'receptionist')
     LIMIT 1;
    IF v_actual_role IS NULL OR v_actual_role IS DISTINCT FROM p_actor_role THEN
      RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
    END IF;
  ELSIF p_actor_role NOT IN ('system', 'demo_cookie') THEN
    RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
  ELSE
    v_actual_role := p_actor_role;
  END IF;

  SELECT b.*
    INTO v_booking
    FROM public.bookings b
   WHERE b.id = p_booking_id
     AND b.salon_id = p_salon_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;

  IF p_reason = 'walkin_removed' THEN
    IF v_booking.status <> 'waiting' OR v_booking.source <> 'walkin' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
    END IF;
    v_next_status := 'cancelled';
  ELSIF p_reason = 'desk_cancel' THEN
    IF v_booking.status NOT IN ('pending', 'confirmed', 'in_progress') THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
    END IF;
    v_next_status := 'cancelled';
  ELSIF p_reason = 'wix_decline' THEN
    IF v_booking.status <> 'pending' OR v_booking.wix_booking_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
    END IF;
    v_next_status := 'cancelled';
  ELSE
    IF v_booking.status NOT IN ('confirmed', 'in_progress') THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
    END IF;
    v_next_status := 'no_show';
  END IF;

  PERFORM pg_catalog.set_config(
    'nailiq.v1_terminal_actor_user_id',
    coalesce(p_actor_user_id::text, ''),
    true
  );
  PERFORM pg_catalog.set_config(
    'nailiq.v1_terminal_actor_role',
    v_actual_role,
    true
  );
  PERFORM pg_catalog.set_config('nailiq.v1_terminal_reason', p_reason, true);

  BEGIN
    UPDATE public.bookings b
       SET status = v_next_status,
           no_show_candidate_at = CASE
             WHEN v_next_status = 'no_show' THEN NULL
             ELSE b.no_show_candidate_at
           END,
           staff_action_notification_request_id = CASE
             WHEN v_notification_requested THEN p_notification_request_id
             ELSE b.staff_action_notification_request_id
           END,
           staff_action_notification_actor_user_id = CASE
             WHEN v_notification_requested THEN p_actor_user_id
             ELSE b.staff_action_notification_actor_user_id
           END,
           staff_action_notification_actor_role = CASE
             WHEN v_notification_requested THEN v_actual_role
             ELSE b.staff_action_notification_actor_role
           END,
           staff_action_notification_channels = CASE
             WHEN v_notification_requested THEN jsonb_build_object(
               'sms', coalesce(p_notify_sms, false),
               'email', coalesce(p_notify_email, false)
             )
             ELSE b.staff_action_notification_channels
           END,
           staff_action_notification_delay_seconds = CASE
             WHEN v_notification_requested THEN p_notification_delay_seconds
             ELSE b.staff_action_notification_delay_seconds
           END
     WHERE b.id = p_booking_id
       AND b.salon_id = p_salon_id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_user_id', '', true);
    PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_role', '', true);
    PERFORM pg_catalog.set_config('nailiq.v1_terminal_reason', '', true);
    RAISE;
  END;

  PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_user_id', '', true);
  PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_role', '', true);
  PERFORM pg_catalog.set_config('nailiq.v1_terminal_reason', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'code', 'transitioned',
    'booking', jsonb_build_object(
      'id', v_booking.id,
      'salon_id', v_booking.salon_id,
      'service_id', v_booking.service_id,
      'client_phone', v_booking.client_phone,
      'client_name', v_booking.client_name,
      'client_email', v_booking.client_email,
      'previous_status', v_booking.status,
      'status', v_next_status
    )
  );
END
$function$;

-- Only the immediate toast correction remains in V1. The cancellation event
-- used to measure the window was committed atomically by the trigger above.
CREATE OR REPLACE FUNCTION public.undo_recent_cancelled_booking_v1(
  p_booking_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_actual_role text;
  v_booking public.bookings%rowtype;
  v_cancel_event public.booking_events%rowtype;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_booking_id IS NULL OR p_salon_id IS NULL OR p_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;

  SELECT sm.role
    INTO v_actual_role
    FROM public.salon_members sm
   WHERE sm.salon_id = p_salon_id
     AND sm.user_id = p_actor_user_id
     AND sm.role IN ('owner', 'admin', 'senior', 'receptionist')
   LIMIT 1;
  IF v_actual_role IS NULL OR v_actual_role IS DISTINCT FROM p_actor_role THEN
    RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
  END IF;

  SELECT b.*
    INTO v_booking
    FROM public.bookings b
   WHERE b.id = p_booking_id
     AND b.salon_id = p_salon_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;

  IF v_booking.status = 'confirmed'
     AND EXISTS (
       SELECT 1
         FROM public.booking_events e
        WHERE e.booking_id = p_booking_id
          AND e.salon_id = p_salon_id
          AND e.event_type = 'terminal_booking_transition_authorized'
          AND e.payload ->> 'source' = 'v1_terminal_booking_policy'
          AND e.payload ->> 'from' = 'cancelled'
          AND e.payload ->> 'to' = 'confirmed'
          AND e.payload ->> 'reason' = 'immediate_cancel_undo'
          AND e.actor_user_id = p_actor_user_id
     ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'code', 'undo_replay',
      'idempotent', true,
      'booking_id', p_booking_id
    );
  END IF;
  IF v_booking.status <> 'cancelled' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_state');
  END IF;

  SELECT e.*
    INTO v_cancel_event
    FROM public.booking_events e
   WHERE e.booking_id = p_booking_id
     AND e.salon_id = p_salon_id
     AND e.event_type = 'terminal_booking_transition_authorized'
     AND e.payload ->> 'source' = 'v1_terminal_booking_policy'
     AND e.payload ->> 'to' = 'cancelled'
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT 1;
  IF NOT FOUND
     OR clock_timestamp() > v_cancel_event.created_at + interval '8 seconds' THEN
    RETURN jsonb_build_object('success', false, 'code', 'undo_window_expired');
  END IF;

  PERFORM pg_catalog.set_config(
    'nailiq.v1_terminal_actor_user_id',
    p_actor_user_id::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'nailiq.v1_terminal_actor_role',
    v_actual_role,
    true
  );
  PERFORM pg_catalog.set_config(
    'nailiq.v1_terminal_reason',
    'immediate_cancel_undo',
    true
  );
  PERFORM pg_catalog.set_config(
    'nailiq.v1_terminal_undo_booking_id',
    p_booking_id::text,
    true
  );

  BEGIN
    UPDATE public.bookings b
       SET status = 'confirmed'
     WHERE b.id = p_booking_id
       AND b.salon_id = p_salon_id
       AND b.status = 'cancelled';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'immediate cancel undo lost its locked row'
        USING errcode = 'NI002';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_user_id', '', true);
    PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_role', '', true);
    PERFORM pg_catalog.set_config('nailiq.v1_terminal_reason', '', true);
    PERFORM pg_catalog.set_config('nailiq.v1_terminal_undo_booking_id', '', true);
    RAISE;
  END;

  PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_user_id', '', true);
  PERFORM pg_catalog.set_config('nailiq.v1_terminal_actor_role', '', true);
  PERFORM pg_catalog.set_config('nailiq.v1_terminal_reason', '', true);
  PERFORM pg_catalog.set_config('nailiq.v1_terminal_undo_booking_id', '', true);

  RETURN jsonb_build_object(
    'success', true,
    'code', 'cancel_undone',
    'idempotent', false,
    'booking_id', p_booking_id
  );
END
$function$;

REVOKE ALL ON FUNCTION public.transition_booking_to_terminal_v1(
  uuid, uuid, uuid, text, text, uuid, boolean, boolean, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_booking_to_terminal_v1(
  uuid, uuid, uuid, text, text, uuid, boolean, boolean, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.undo_recent_cancelled_booking_v1(
  uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_recent_cancelled_booking_v1(
  uuid, uuid, uuid, text
) TO service_role;
