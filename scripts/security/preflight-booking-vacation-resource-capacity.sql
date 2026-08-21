\set ON_ERROR_STOP on

DO $$
DECLARE
  v_vacation_conflicts bigint;
  v_missing_resources bigint;
  v_invalid_resources bigint;
BEGIN
  SELECT count(*) INTO v_vacation_conflicts
  FROM public.bookings b
  JOIN public.salons s ON s.id = b.salon_id
  JOIN public.staff_unavailability su
    ON su.salon_id = b.salon_id AND su.staff_id = b.staff_id
   AND su.date BETWEEN
     (b.start_time_utc AT TIME ZONE s.timezone)::date AND
     ((b.end_time_utc - interval '1 microsecond') AT TIME ZONE s.timezone)::date
  WHERE b.deleted_at IS NULL
    AND b.status NOT IN ('cancelled', 'no_show', 'completed');

  SELECT count(*) INTO v_missing_resources
  FROM public.bookings b
  JOIN public.salons s ON s.id = b.salon_id AND s.resources_enabled IS TRUE
  WHERE b.deleted_at IS NULL
    AND b.status NOT IN ('cancelled', 'no_show', 'completed')
    AND b.resource_id IS NULL;

  SELECT count(*) INTO v_invalid_resources
  FROM public.bookings b
  JOIN public.salons s ON s.id = b.salon_id AND s.resources_enabled IS TRUE
  LEFT JOIN public.salon_resources r
    ON r.id = b.resource_id AND r.salon_id = b.salon_id
   AND r.status = 'active' AND r.deleted_at IS NULL
  WHERE b.deleted_at IS NULL
    AND b.status NOT IN ('cancelled', 'no_show', 'completed')
    AND b.resource_id IS NOT NULL AND r.id IS NULL;

  RAISE NOTICE
    'capacity preflight: vacation_conflicts=%, missing_resources=%, invalid_resources=%',
    v_vacation_conflicts, v_missing_resources, v_invalid_resources;
  IF v_vacation_conflicts <> 0 OR v_missing_resources <> 0
     OR v_invalid_resources <> 0 THEN
    RAISE EXCEPTION
      'capacity rollout needs data reconciliation before enforcement';
  END IF;
END
$$;

SELECT relname, pg_catalog.pg_size_pretty(
  pg_catalog.pg_total_relation_size(c.oid)
) AS total_size
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('bookings', 'booking_service_segments',
                    'staff_unavailability', 'salon_resources')
ORDER BY relname;

SELECT 'booking vacation/resource capacity preflight passed' AS result;
