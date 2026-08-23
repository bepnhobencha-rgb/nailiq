-- MQA-0177: deterministic chair/resource balancing.
--
-- The booking-sequence resolver remains authoritative for availability and
-- conflict prevention. This helper only ranks resources that already passed
-- those checks. Explicit preferred_resource_id values never enter the ranking.
-- Completed work counts toward same-day wear; cancelled/no-show work does not.
CREATE OR REPLACE FUNCTION public.salon_resource_booked_minutes_for_day(
  p_salon_id uuid,
  p_resource_id uuid,
  p_local_day date,
  p_timezone text,
  p_prior_lines jsonb,
  p_exclude_booking_id uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $resource_minutes$
  WITH bounds AS (
    SELECT
      p_local_day::timestamp AT TIME ZONE p_timezone AS day_start_utc,
      (p_local_day + 1)::timestamp AT TIME ZONE p_timezone AS day_end_utc
  ), occupied AS (
    SELECT b.start_time_utc AS occupied_start_utc,
           b.end_time_utc AS occupied_end_utc
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND b.resource_id = p_resource_id
      AND b.schedule_model = 'single'
      AND b.id IS DISTINCT FROM p_exclude_booking_id
      AND b.status NOT IN ('cancelled', 'no_show')
      AND b.deleted_at IS NULL

    UNION ALL

    SELECT seg.occupied_start_utc, seg.occupied_end_utc
    FROM public.booking_service_segments seg
    WHERE seg.salon_id = p_salon_id
      AND seg.resource_id = p_resource_id
      AND seg.booking_id IS DISTINCT FROM p_exclude_booking_id
      AND seg.reservation_status NOT IN ('cancelled', 'no_show')

    UNION ALL

    SELECT
      (prior.value->>'occupied_start_utc')::timestamptz,
      (prior.value->>'occupied_end_utc')::timestamptz
    FROM pg_catalog.jsonb_array_elements(
      coalesce(p_prior_lines, '[]'::jsonb)
    ) prior(value)
    WHERE prior.value->>'resource_id' = p_resource_id::text
  )
  SELECT coalesce(sum(
    floor(
      extract(epoch FROM (
        least(o.occupied_end_utc, b.day_end_utc)
        - greatest(o.occupied_start_utc, b.day_start_utc)
      )) / 60
    )::bigint
  ), 0)::bigint
  FROM occupied o
  CROSS JOIN bounds b
  WHERE o.occupied_start_utc < b.day_end_utc
    AND o.occupied_end_utc > b.day_start_utc
    AND o.occupied_end_utc > o.occupied_start_utc;
$resource_minutes$;

REVOKE ALL ON FUNCTION public.salon_resource_booked_minutes_for_day(
  uuid, uuid, date, text, jsonb, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salon_resource_booked_minutes_for_day(
  uuid, uuid, date, text, jsonb, uuid
) TO service_role;

COMMENT ON FUNCTION public.salon_resource_booked_minutes_for_day(
  uuid, uuid, date, text, jsonb, uuid
) IS 'Internal MQA-0177 resource wear score. Salon/day scoped; includes completed work and current quote lines; excludes cancelled/no-show work.';

-- This resolver is intentionally large and has one authoritative definition.
-- Patch only its three exact auto-resource tie-breaks in place so this forward
-- migration cannot drift from unrelated pricing, timing, or locking behavior.
-- Fail closed if the expected predecessor shape is not present.
DO $patch_resource_ranking$
DECLARE
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.resolve_booking_sequence_pricing_and_schedule(jsonb,boolean)'
  );
  v_definition text;
  v_pattern constant text := 'ORDER BY r.id LIMIT 1';
  v_replacement constant text :=
    'ORDER BY public.salon_resource_booked_minutes_for_day(' ||
    'v_salon_id, r.id, ' ||
    '(v_occupied_start AT TIME ZONE v_timezone)::date, ' ||
    'v_timezone, v_lines, v_exclude_booking_id' ||
    ') ASC, r.display_order ASC, r.id LIMIT 1';
  v_match_count integer;
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'authoritative booking-sequence resolver is missing';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(v_function);
  v_match_count := (
    length(v_definition) - length(replace(v_definition, v_pattern, ''))
  ) / length(v_pattern);

  IF v_match_count <> 3 THEN
    RAISE EXCEPTION
      'expected exactly 3 resource UUID tie-breaks, found %', v_match_count;
  END IF;

  v_definition := replace(v_definition, v_pattern, v_replacement);
  EXECUTE v_definition;

  IF (
    length(pg_catalog.pg_get_functiondef(v_function))
      - length(replace(
          pg_catalog.pg_get_functiondef(v_function),
          'salon_resource_booked_minutes_for_day',
          ''
        ))
  ) / length('salon_resource_booked_minutes_for_day') <> 3 THEN
    RAISE EXCEPTION 'resource balancing patch verification failed';
  END IF;
END;
$patch_resource_ranking$;

COMMENT ON FUNCTION public.resolve_booking_sequence_pricing_and_schedule(
  jsonb, boolean
) IS 'Authoritative sequence quote/create resolver. Auto resources are availability-first, then balanced by salon-local booked minutes with display_order/UUID stable tie-breaks; explicit preferences are preserved.';
