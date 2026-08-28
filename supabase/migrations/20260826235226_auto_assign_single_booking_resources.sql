-- Resource-mode salons are fully automatic: a caller may omit resource_id and
-- the database assigns the first free active resource inside the same
-- transaction as the booking write. This closes the Group/Party gap where the
-- scheduler found free staff but canonical group creation always sent NULL for
-- every bed/chair.
--
-- The trigger name intentionally sorts before every `enforce_*` booking trigger.
-- Automatic writers therefore acquire the salon resource-allocation lock before
-- later staff/resource locks, giving concurrent group transactions one stable
-- lock order and avoiding cross-member deadlocks.

CREATE OR REPLACE FUNCTION public.auto_assign_single_booking_resource()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_resources_enabled boolean;
  v_resource_id uuid;
BEGIN
  IF NEW.schedule_model <> 'single'
     OR NEW.deleted_at IS NOT NULL
     OR NEW.status IN ('cancelled', 'no_show', 'completed')
     OR NEW.resource_id IS NOT NULL
     OR NEW.salon_id IS NULL
     OR NEW.start_time_utc IS NULL
     OR NEW.end_time_utc IS NULL
     OR NEW.start_time_utc >= NEW.end_time_utc THEN
    RETURN NEW;
  END IF;

  SELECT s.resources_enabled
  INTO v_resources_enabled
  FROM public.salons AS s
  WHERE s.id = NEW.salon_id;
  IF NOT FOUND OR v_resources_enabled IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Transaction scoped: released automatically on commit/rollback. Group
  -- members inserted later in this transaction can see the earlier members and
  -- therefore receive different resources without any partial persistence.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'booking-capacity:resource-auto:' || NEW.salon_id::text,
      0
    )
  );

  SELECT r.id
  INTO v_resource_id
  FROM public.salon_resources AS r
  WHERE r.salon_id = NEW.salon_id
    AND r.status = 'active'
    AND r.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.bookings AS b
      WHERE b.salon_id = NEW.salon_id
        AND b.id IS DISTINCT FROM NEW.id
        AND b.resource_id = r.id
        AND b.deleted_at IS NULL
        AND b.status NOT IN ('cancelled', 'no_show', 'completed')
        AND pg_catalog.tstzrange(
          b.start_time_utc, b.end_time_utc, '[)'
        ) && pg_catalog.tstzrange(
          NEW.start_time_utc, NEW.end_time_utc, '[)'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.booking_service_segments AS seg
      WHERE seg.salon_id = NEW.salon_id
        AND seg.resource_id = r.id
        AND seg.reservation_status NOT IN (
          'cancelled', 'no_show', 'completed'
        )
        AND pg_catalog.tstzrange(
          seg.occupied_start_utc, seg.occupied_end_utc, '[)'
        ) && pg_catalog.tstzrange(
          NEW.start_time_utc, NEW.end_time_utc, '[)'
        )
    )
  ORDER BY r.display_order, r.id
  LIMIT 1;

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01', MESSAGE = 'active resource unavailable';
  END IF;

  NEW.resource_id := v_resource_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_assign_single_booking_resource()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a_auto_assign_single_booking_resource
  ON public.bookings;
CREATE TRIGGER a_auto_assign_single_booking_resource
  BEFORE INSERT OR UPDATE OF
    salon_id, resource_id, start_time_utc, end_time_utc,
    status, deleted_at, schedule_model
  ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_assign_single_booking_resource();

COMMENT ON FUNCTION public.auto_assign_single_booking_resource() IS
  'Concurrency-safe automatic physical-resource assignment for live single-model bookings when resource_id is omitted.';

DO $proof$
DECLARE
  v_oid regprocedure :=
    'public.auto_assign_single_booking_resource()'::regprocedure;
  v_def text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(v_oid) INTO v_def;
  IF position('booking-capacity:resource-auto:' IN v_def) = 0
     OR position('NEW.resource_id := v_resource_id' IN v_def) = 0
     OR position('public.booking_service_segments AS seg' IN v_def) = 0
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.bookings'::regclass
         AND tgname = 'a_auto_assign_single_booking_resource'
         AND NOT tgisinternal
     )
     OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'automatic resource allocation boundary mismatch';
  END IF;
END
$proof$;
