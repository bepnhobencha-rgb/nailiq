-- Close the remaining browser-write bypass around staff offboarding.
--
-- Authenticated owners/admins may continue editing ordinary profile fields,
-- but an active staff member may become non-active or deleted only through the
-- service-role-only atomic offboarding RPC. That RPC enforces the minimum
-- active-staff rule and writes the durable receipt/audit/outbox in the same
-- transaction. Service-role maintenance and disposable-test cleanup retain
-- their direct zero-live write path; live assignments remain fail-closed.

BEGIN;

SET LOCAL lock_timeout='5s';
LOCK TABLE public.staff IN SHARE ROW EXCLUSIVE MODE;

DROP POLICY IF EXISTS "managers delete staff for own salon" ON public.staff;
REVOKE DELETE ON TABLE public.staff FROM authenticated;

DO $staff_lifecycle_acl_preflight$
BEGIN
  IF pg_catalog.has_table_privilege(
       'authenticated','public.staff','DELETE'
     ) THEN
    RAISE EXCEPTION 'authenticated staff DELETE privilege remains reachable';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policies p
    WHERE p.schemaname='public' AND p.tablename='staff'
      AND p.cmd IN ('DELETE','ALL')
      AND (
        p.roles @> ARRAY['authenticated']::name[]
        OR p.roles @> ARRAY['public']::name[]
      )
  ) THEN
    RAISE EXCEPTION 'authenticated staff DELETE policy remains reachable';
  END IF;
  IF NOT pg_catalog.has_table_privilege(
       'service_role','public.staff','DELETE'
     ) THEN
    RAISE EXCEPTION 'service-role staff cleanup privilege missing';
  END IF;
END;
$staff_lifecycle_acl_preflight$;

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
  IF TG_OP='UPDATE' AND NEW.salon_id IS DISTINCT FROM OLD.salon_id THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE='staff salon_id is immutable';
  END IF;

  IF TG_OP='UPDATE' AND NOT (
    (
      OLD.status='active'
      AND NEW.status IS DISTINCT FROM OLD.status
      AND NEW.status<>'active'
    )
    OR (
      NEW.deleted_at IS NOT NULL
      AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    )
  ) THEN
    RETURN NEW;
  END IF;

  -- Preserve whole-salon ON DELETE CASCADE. The parent row is already absent
  -- in this transaction, so no staff or assignment survives the operation.
  IF TG_OP='DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.salons s WHERE s.id=v_salon_id
  ) THEN
    RETURN OLD;
  END IF;

  -- Browser roles must never bypass the atomic receipt/minimum-active
  -- contract, including when the target currently has zero live assignments.
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE='staff lifecycle changes require atomic offboarding';
  END IF;

  -- Trusted maintenance writes still cannot strand live work. Do not lock the
  -- booking rows here: assignment writers lock the already-held staff row and
  -- recheck after this transaction, preserving the established lock order.
  IF EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.staff_id=v_staff_id
      AND b.deleted_at IS NULL
      AND b.status IN ('pending','confirmed','in_progress','waiting')
  ) OR EXISTS (
    SELECT 1
    FROM public.booking_service_segments seg
    WHERE seg.staff_id=v_staff_id
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

DROP TRIGGER IF EXISTS enforce_no_live_assignments_before_staff_deactivation
  ON public.staff;
CREATE TRIGGER enforce_no_live_assignments_before_staff_deactivation
  BEFORE UPDATE OF status,deleted_at,salon_id OR DELETE
  ON public.staff
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_no_live_assignments_on_staff_deactivation();

COMMENT ON FUNCTION public.enforce_no_live_assignments_on_staff_deactivation()
  IS 'Requires browser-originated staff lifecycle changes to use the service-role atomic offboarding RPC; preserves whole-salon cascade and rejects trusted direct writes that would strand live assignments.';

COMMIT;
