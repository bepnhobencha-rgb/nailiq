-- Forward fix for QA branches that already applied 20260830100409.
-- Occupied prep/trailing buffers may overlap inside a sequential booking; only
-- overlapping guest-facing service intervals require a certified parallel pair.

CREATE OR REPLACE FUNCTION public.enforce_parallel_segment_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $parallel_segment_policy$
DECLARE
  v_prior public.booking_service_segments%ROWTYPE;
  v_policy_mode text;
  v_resource_capacity integer;
  v_same_resource_overlap_count integer;
  v_service_a uuid;
  v_service_b uuid;
BEGIN
  IF NEW.reservation_status IN ('cancelled', 'no_show', 'completed') THEN
    RETURN NEW;
  END IF;

  FOR v_prior IN
    SELECT seg.*
    FROM public.booking_service_segments seg
    WHERE seg.booking_id = NEW.booking_id
      AND seg.id IS DISTINCT FROM NEW.id
      AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
      AND pg_catalog.tstzrange(seg.customer_start_utc, seg.customer_end_utc, '[)')
        && pg_catalog.tstzrange(NEW.customer_start_utc, NEW.customer_end_utc, '[)')
    ORDER BY seg.position, seg.id
  LOOP
    IF v_prior.staff_id = NEW.staff_id THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'parallel services require distinct staff';
    END IF;

    v_service_a := CASE WHEN v_prior.service_id::text < NEW.service_id::text
      THEN v_prior.service_id ELSE NEW.service_id END;
    v_service_b := CASE WHEN v_prior.service_id::text < NEW.service_id::text
      THEN NEW.service_id ELSE v_prior.service_id END;

    SELECT p.resource_mode INTO v_policy_mode
    FROM public.service_parallel_policies p
    WHERE p.salon_id = NEW.salon_id
      AND p.service_a_id = v_service_a
      AND p.service_b_id = v_service_b
      AND p.active IS TRUE;

    IF v_policy_mode IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'parallel service pair is not allowed';
    END IF;

    IF NEW.resource_id IS NOT DISTINCT FROM v_prior.resource_id THEN
      IF NEW.resource_id IS NULL OR v_policy_mode NOT IN ('shared', 'either') THEN
        RAISE EXCEPTION USING ERRCODE = '23P01',
          MESSAGE = 'parallel service pair cannot share this resource';
      END IF;

      SELECT r.same_guest_parallel_capacity INTO v_resource_capacity
      FROM public.salon_resources r
      WHERE r.id = NEW.resource_id
        AND r.salon_id = NEW.salon_id
        AND r.status = 'active'
        AND r.deleted_at IS NULL
      FOR KEY SHARE;

      SELECT count(*) + 1 INTO v_same_resource_overlap_count
      FROM public.booking_service_segments seg
      WHERE seg.booking_id = NEW.booking_id
        AND seg.id IS DISTINCT FROM NEW.id
        AND seg.resource_id = NEW.resource_id
        AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
        AND pg_catalog.tstzrange(seg.customer_start_utc, seg.customer_end_utc, '[)')
          && pg_catalog.tstzrange(NEW.customer_start_utc, NEW.customer_end_utc, '[)');

      IF v_resource_capacity IS NULL
         OR v_same_resource_overlap_count > v_resource_capacity THEN
        RAISE EXCEPTION USING ERRCODE = '23P01',
          MESSAGE = 'shared resource parallel capacity exceeded';
      END IF;
    ELSIF v_policy_mode NOT IN ('distinct', 'either') THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'parallel service pair requires one shared resource';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$parallel_segment_policy$;

REVOKE ALL ON FUNCTION public.enforce_parallel_segment_policy()
  FROM PUBLIC, anon, authenticated;
