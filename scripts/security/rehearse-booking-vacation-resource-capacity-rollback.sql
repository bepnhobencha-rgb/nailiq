\set ON_ERROR_STOP on
BEGIN;

DROP TRIGGER enforce_segment_operational_capacity_guard
  ON public.booking_service_segments;
DROP TRIGGER enforce_booking_operational_capacity_guard ON public.bookings;
DROP FUNCTION public.enforce_booking_operational_capacity_guard();

DO $$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.enforce_booking_operational_capacity_guard()'
  ) IS NOT NULL OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgname IN (
      'enforce_booking_operational_capacity_guard',
      'enforce_segment_operational_capacity_guard'
    ) AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'capacity down rehearsal left contract behind';
  END IF;
END
$$;

ROLLBACK;

DO $$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.enforce_booking_operational_capacity_guard()'
  ) IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.bookings'::regclass
      AND tgname = 'enforce_booking_operational_capacity_guard'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.booking_service_segments'::regclass
      AND tgname = 'enforce_segment_operational_capacity_guard'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'rollback did not restore capacity contract';
  END IF;
END
$$;

SELECT 'booking vacation/resource capacity rollback passed' AS result;
