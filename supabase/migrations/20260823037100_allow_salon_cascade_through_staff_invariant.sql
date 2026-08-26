-- Forward-only correction: deleting an entire salon legitimately cascades all
-- bookings, segments and staff in one transaction. The staff invariant must
-- still reject a direct staff delete while allowing that parent-row cascade.

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

  -- The parent salon row is no longer visible while its ON DELETE CASCADE is
  -- deleting children. Every referenced row is disappearing atomically, so
  -- there is no surviving inactive/deleted-staff assignment to reject.
  IF TG_OP='DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.salons s WHERE s.id=v_salon_id
  ) THEN
    RETURN OLD;
  END IF;

  -- Do not lock booking/segment rows here: the staff row is already locked.
  -- Concurrent assignment writers wait on it FOR UPDATE and recheck after the
  -- status/delete transaction commits, avoiding an inverse-lock deadlock.
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
