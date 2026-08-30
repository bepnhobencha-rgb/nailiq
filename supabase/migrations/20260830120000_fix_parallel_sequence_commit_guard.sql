-- Parallel quotes must be able to commit, while every overlapping customer
-- interval remains fail-closed behind the salon-owned pair/resource policy.
-- The original deferred shape trigger rejected every overlap before parallel
-- service support existed. Replace that blanket rule with the certified policy
-- contract and anchor the parent end to the latest segment, not the last line.

CREATE OR REPLACE FUNCTION public.check_booking_service_sequence_shape()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_shape$
DECLARE
  v_booking_id uuid := coalesce(NEW.booking_id, OLD.booking_id);
  v_count integer;
  v_min integer;
  v_max integer;
  v_max_customer_end timestamptz;
  v_parent public.bookings%ROWTYPE;
BEGIN
  SELECT b.* INTO v_parent
  FROM public.bookings b
  WHERE b.id = v_booking_id;

  IF NOT FOUND OR v_parent.schedule_model <> 'segments_v1' THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  SELECT count(*), min(seg.position), max(seg.position), max(seg.customer_end_utc)
  INTO v_count, v_min, v_max, v_max_customer_end
  FROM public.booking_service_segments seg
  WHERE seg.booking_id = v_booking_id;

  IF v_count NOT BETWEEN 1 AND 5 OR v_min <> 0 OR v_max <> v_count - 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'sequence positions must be contiguous 0..N-1 where N is 1..5';
  END IF;

  -- Every pair of overlapping guest-facing intervals must use distinct staff
  -- and satisfy one active salon-owned service/resource policy. Prep/buffer
  -- overlap remains allowed because it is not customer-facing concurrency.
  IF EXISTS (
    SELECT 1
    FROM public.booking_service_segments left_seg
    JOIN public.booking_service_segments right_seg
      ON right_seg.booking_id = left_seg.booking_id
     AND right_seg.position > left_seg.position
    WHERE left_seg.booking_id = v_booking_id
      AND left_seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
      AND right_seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
      AND pg_catalog.tstzrange(
        left_seg.customer_start_utc, left_seg.customer_end_utc, '[)'
      ) && pg_catalog.tstzrange(
        right_seg.customer_start_utc, right_seg.customer_end_utc, '[)'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.service_parallel_policies policy
        WHERE policy.salon_id = left_seg.salon_id
          AND policy.service_a_id = CASE
            WHEN left_seg.service_id::text < right_seg.service_id::text
              THEN left_seg.service_id ELSE right_seg.service_id END
          AND policy.service_b_id = CASE
            WHEN left_seg.service_id::text < right_seg.service_id::text
              THEN right_seg.service_id ELSE left_seg.service_id END
          AND policy.active IS TRUE
          AND left_seg.staff_id <> right_seg.staff_id
          AND (
            (
              left_seg.resource_id = right_seg.resource_id
              AND left_seg.resource_id IS NOT NULL
              AND policy.resource_mode IN ('shared', 'either')
              AND EXISTS (
                SELECT 1
                FROM public.salon_resources shared_resource
                WHERE shared_resource.id = left_seg.resource_id
                  AND shared_resource.salon_id = left_seg.salon_id
                  AND shared_resource.status = 'active'
                  AND shared_resource.deleted_at IS NULL
                  AND shared_resource.same_guest_parallel_capacity >= 2
              )
            )
            OR
            (
              left_seg.resource_id IS DISTINCT FROM right_seg.resource_id
              AND left_seg.resource_id IS NOT NULL
              AND right_seg.resource_id IS NOT NULL
              AND policy.resource_mode IN ('distinct', 'either')
              AND EXISTS (
                SELECT 1
                FROM public.salon_resources left_resource
                WHERE left_resource.id = left_seg.resource_id
                  AND left_resource.salon_id = left_seg.salon_id
                  AND left_resource.status = 'active'
                  AND left_resource.deleted_at IS NULL
              )
              AND EXISTS (
                SELECT 1
                FROM public.salon_resources right_resource
                WHERE right_resource.id = right_seg.resource_id
                  AND right_resource.salon_id = right_seg.salon_id
                  AND right_resource.status = 'active'
                  AND right_resource.deleted_at IS NULL
              )
            )
          )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'sequence parallel overlap violates certified policy';
  END IF;

  -- Resource capacity is currently constrained to at most two. Pair-wise
  -- certification alone must not permit three segments to overlap on one chair.
  IF EXISTS (
    SELECT 1
    FROM public.booking_service_segments first_seg
    JOIN public.booking_service_segments second_seg
      ON second_seg.booking_id = first_seg.booking_id
     AND second_seg.id > first_seg.id
     AND second_seg.resource_id = first_seg.resource_id
    JOIN public.booking_service_segments third_seg
      ON third_seg.booking_id = first_seg.booking_id
     AND third_seg.id > second_seg.id
     AND third_seg.resource_id = first_seg.resource_id
    WHERE first_seg.booking_id = v_booking_id
      AND first_seg.resource_id IS NOT NULL
      AND first_seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
      AND second_seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
      AND third_seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
      AND greatest(
        first_seg.customer_start_utc,
        second_seg.customer_start_utc,
        third_seg.customer_start_utc
      ) < least(
        first_seg.customer_end_utc,
        second_seg.customer_end_utc,
        third_seg.customer_end_utc
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'sequence shared resource parallel capacity exceeded';
  END IF;

  -- Persisted timing must match the canonical quote snapshot. In particular,
  -- a line labelled parallel may not be silently moved after the prior line.
  IF pg_catalog.jsonb_typeof(v_parent.public_booking_pricing_snapshot->'segments') = 'array'
     AND EXISTS (
       SELECT 1
       FROM public.booking_service_segments seg
       LEFT JOIN public.booking_service_segments prior
         ON prior.booking_id = seg.booking_id
        AND prior.position = seg.position - 1
       JOIN LATERAL pg_catalog.jsonb_array_elements(
         v_parent.public_booking_pricing_snapshot->'segments'
       ) snapshot(value)
         ON snapshot.value->>'line_id' = seg.line_id::text
       WHERE seg.booking_id = v_booking_id
         AND (
           (
             snapshot.value->>'resolved_timing_mode' = 'parallel'
             AND (
               seg.position = 0
               OR prior.id IS NULL
               OR seg.customer_start_utc <> prior.customer_start_utc
               OR seg.staff_id = prior.staff_id
             )
           )
           OR
           (
             snapshot.value->>'resolved_timing_mode' = 'sequential'
             AND seg.position > 0
             AND prior.id IS NOT NULL
             AND seg.customer_start_utc < prior.customer_end_utc
           )
         )
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'sequence persisted timing does not match quote';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.booking_service_segments first_seg
    WHERE first_seg.booking_id = v_booking_id
      AND first_seg.position = 0
      AND v_parent.start_time_utc = first_seg.customer_start_utc
      AND v_parent.end_time_utc = v_max_customer_end
      AND v_parent.service_id = first_seg.service_id
      AND v_parent.staff_id = first_seg.staff_id
      AND v_parent.resource_id IS NOT DISTINCT FROM first_seg.resource_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'sequence parent anchor mismatch';
  END IF;

  RETURN coalesce(NEW, OLD);
END;
$sequence_shape$;

REVOKE ALL ON FUNCTION public.check_booking_service_sequence_shape()
  FROM PUBLIC, anon, authenticated;

-- Customer interval edits are policy-relevant even if occupied bounds are not
-- changed in the same statement. Recreate the immediate trigger with both.
DROP TRIGGER IF EXISTS enforce_parallel_segment_policy
  ON public.booking_service_segments;

CREATE TRIGGER enforce_parallel_segment_policy
  BEFORE INSERT OR UPDATE OF booking_id, salon_id, service_id, staff_id,
    resource_id, customer_start_utc, customer_end_utc,
    occupied_start_utc, occupied_end_utc, reservation_status
  ON public.booking_service_segments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_parallel_segment_policy();
