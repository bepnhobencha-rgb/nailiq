\set ON_ERROR_STOP on

DO $$
DECLARE
  v_oid oid := 'public.enforce_booking_operational_capacity_guard()'::regprocedure;
  v_def text;
  v_auto_oid oid := 'public.auto_assign_single_booking_resource()'::regprocedure;
  v_auto_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = v_oid AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']::text[]
  ) OR pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'capacity guard function ACL/search_path mismatch';
  END IF;

  IF NOT EXISTS (
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
    RAISE EXCEPTION 'capacity guard trigger coverage missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_oid) INTO v_def;
  IF position('public.staff_unavailability' IN v_def) = 0
     OR position('AT TIME ZONE v_timezone' IN v_def) = 0
     OR position('BETWEEN v_local_start_date AND v_local_end_date' IN v_def) = 0
     OR position('v_resources_enabled IS TRUE' IN v_def) = 0
     OR position('r.status = ''active''' IN v_def) = 0
     OR position('r.deleted_at IS NULL' IN v_def) = 0
     OR position('ERRCODE = ''23P01''' IN v_def) = 0
  THEN
    RAISE EXCEPTION 'capacity guard vacation/resource sentinel drifted';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_auto_oid) INTO v_auto_def;
  IF position('booking-capacity:resource-auto:' IN v_auto_def) = 0
     OR position('NEW.resource_id := v_resource_id' IN v_auto_def) = 0
     OR position('public.booking_service_segments AS seg' IN v_auto_def) = 0
     OR pg_catalog.has_function_privilege('public', v_auto_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_auto_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_auto_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('service_role', v_auto_oid, 'EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.bookings'::regclass
         AND tgname = 'a_auto_assign_single_booking_resource'
         AND NOT tgisinternal
     )
  THEN
    RAISE EXCEPTION 'automatic resource assignment boundary drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.bookings'::regclass
      AND conname = 'bookings_resource_no_overlap' AND contype = 'x'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.booking_service_segments'::regclass
      AND conname = 'booking_service_segments_resource_no_overlap'
      AND contype = 'x'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.salon_resources'::regclass
      AND conname = 'salon_resources_kind_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%station%'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%room%'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%other%'
  ) THEN
    RAISE EXCEPTION 'exclusive physical resource schema boundary missing';
  END IF;
END
$$;

SELECT 'booking vacation/resource capacity boundary passed' AS result;
