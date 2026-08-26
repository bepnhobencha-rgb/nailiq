-- Forward-only extension of the staff-side live-assignment invariant.
-- Pending is non-active for public/receptionist scheduling and must not retain
-- live work. A staff row's tenant identity is immutable: moving it would strand
-- capability, shift, unavailability and historical references in another salon.

BEGIN;

SET LOCAL lock_timeout='5s';
LOCK TABLE public.staff IN SHARE ROW EXCLUSIVE MODE;

-- Deployment preflight: legacy writes may have produced a non-active staff row
-- with live assignments before the trigger covered every non-active status.
-- Fail before replacing the guard so operators must repair that drift explicitly.
DO $legacy_nonactive_assignment_preflight$
DECLARE
  v_staff_id uuid;
BEGIN
  SELECT s.id INTO v_staff_id
  FROM public.staff s
  WHERE (s.status IS DISTINCT FROM 'active' OR s.deleted_at IS NOT NULL)
    AND (
      EXISTS (
        SELECT 1 FROM public.bookings b
        WHERE b.staff_id=s.id
          AND b.deleted_at IS NULL
          AND b.status IN ('pending','confirmed','in_progress','waiting')
      )
      OR EXISTS (
        SELECT 1 FROM public.booking_service_segments seg
        WHERE seg.staff_id=s.id
          AND seg.reservation_status IN ('pending','confirmed','in_progress','waiting')
      )
    )
  ORDER BY s.id
  LIMIT 1;

  IF v_staff_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE='23514',
      MESSAGE='legacy non-active staff has live assignments',
      DETAIL=pg_catalog.format('staff_id=%s',v_staff_id),
      HINT='Repair or atomically reassign live work before applying this migration.';
  END IF;
END;
$legacy_nonactive_assignment_preflight$;

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
      NEW.status IS DISTINCT FROM OLD.status
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
  -- in this transaction, so every child assignment is disappearing with it.
  IF TG_OP='DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.salons s WHERE s.id=v_salon_id
  ) THEN
    RETURN OLD;
  END IF;

  -- Scan by globally unique staff id rather than trusting the old salon id.
  -- Do not row-lock here: assignment writers take the already-held staff row
  -- FOR UPDATE and recheck after this transaction commits.
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

DROP TRIGGER enforce_no_live_assignments_before_staff_deactivation
  ON public.staff;
CREATE TRIGGER enforce_no_live_assignments_before_staff_deactivation
  BEFORE UPDATE OF status,deleted_at,salon_id OR DELETE
  ON public.staff
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_no_live_assignments_on_staff_deactivation();

COMMIT;
