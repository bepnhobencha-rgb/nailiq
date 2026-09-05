-- False-waitlist P0: make the database the final authority before an
-- individual capacity-rescue request can become a durable waitlist entry.
-- The audit surface intentionally excludes customer name, phone, and email.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.capacity_rescue_decision_events (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  request_id uuid,
  waitlist_entry_id uuid REFERENCES public.booking_waitlist_entries(id) ON DELETE SET NULL,
  decision_source text NOT NULL,
  request_kind text NOT NULL,
  service_id uuid REFERENCES public.services(id) ON DELETE SET NULL,
  staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  booking_date date,
  preferred_slot_label text,
  outcome text NOT NULL,
  reason_code text NOT NULL,
  eligible_staff_count integer,
  eligible_resource_count integer,
  free_staff_count integer,
  free_resource_count integer,
  app_version text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT capacity_rescue_decision_source_check CHECK (
    decision_source IN ('application_precheck', 'database_guard')
  ),
  CONSTRAINT capacity_rescue_decision_request_kind_check CHECK (
    request_kind IN ('individual', 'sequence', 'group')
  ),
  CONSTRAINT capacity_rescue_decision_outcome_check CHECK (
    outcome IN (
      'slot_available', 'slot_unavailable', 'availability_unverified',
      'capacity_not_applicable', 'created', 'idempotent'
    )
  ),
  CONSTRAINT capacity_rescue_decision_counts_check CHECK (
    (eligible_staff_count IS NULL OR eligible_staff_count >= 0)
    AND (eligible_resource_count IS NULL OR eligible_resource_count >= 0)
    AND (free_staff_count IS NULL OR free_staff_count >= 0)
    AND (free_resource_count IS NULL OR free_resource_count >= 0)
  )
);

ALTER TABLE public.capacity_rescue_decision_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.capacity_rescue_decision_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.capacity_rescue_decision_events
  TO service_role;

CREATE INDEX IF NOT EXISTS capacity_rescue_decision_salon_created_idx
  ON public.capacity_rescue_decision_events (salon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS capacity_rescue_decision_request_idx
  ON public.capacity_rescue_decision_events (request_id)
  WHERE request_id IS NOT NULL;

COMMENT ON TABLE public.capacity_rescue_decision_events IS
  'PII-free evidence for capacity-rescue decisions. Never store customer name, phone, email, notes, or raw intent.';

CREATE OR REPLACE FUNCTION public.evaluate_individual_waitlist_capacity(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_booking_date date,
  p_preferred_slot_label text
)
RETURNS TABLE(
  outcome text,
  slot_label text,
  eligible_staff_count integer,
  eligible_resource_count integer,
  free_staff_count integer,
  free_resource_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_timezone text;
  v_opening_hours jsonb;
  v_closed_dates jsonb;
  v_resources_enabled boolean;
  v_lead_minutes integer;
  v_duration integer;
  v_buffer integer;
  v_resource_mode text;
  v_required_kinds text[];
  v_day_key text;
  v_day jsonb;
  v_open_min integer;
  v_close_min integer;
  v_requested_min integer;
  v_requested_label text := nullif(pg_catalog.btrim(coalesce(p_preferred_slot_label, '')), '');
  v_match text[];
  v_hour integer;
  v_minute integer;
  v_ampm text;
  v_candidate_min integer;
  v_candidate_start timestamptz;
  v_candidate_end timestamptz;
  v_customer_end timestamptz;
  v_requires_resource boolean;
  v_has_capability_rows boolean;
  v_eligible_staff integer := 0;
  v_eligible_resources integer := 0;
  v_free_staff integer := 0;
  v_free_resources integer := 0;
  v_first_free_staff integer := 0;
  v_first_free_resources integer := 0;
  v_seen_candidate boolean := false;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  BEGIN
    SELECT
      nullif(pg_catalog.btrim(s.timezone), ''),
      s.opening_hours,
      s.booking_closed_dates,
      coalesce(s.resources_enabled, false),
      coalesce(s.booking_lead_minutes, 15)
    INTO
      v_timezone, v_opening_hours, v_closed_dates,
      v_resources_enabled, v_lead_minutes
    FROM public.salons AS s
    WHERE s.id = p_salon_id
      AND s.profile_complete;

    IF NOT FOUND OR v_timezone IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_timezone_names AS tz
      WHERE tz.name = v_timezone
    ) THEN
      RETURN QUERY SELECT 'availability_unverified', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;

    SELECT
      svc.duration_minutes,
      coalesce(svc.buffer_minutes, 0),
      coalesce(svc.resource_requirement_mode, 'salon_default'),
      coalesce(svc.required_resource_kinds, '{}'::text[])
    INTO v_duration, v_buffer, v_resource_mode, v_required_kinds
    FROM public.services AS svc
    WHERE svc.id = p_service_id
      AND svc.salon_id = p_salon_id
      AND svc.deleted_at IS NULL
      AND NOT svc.is_addon;

    IF NOT FOUND OR v_duration IS NULL OR v_duration <= 0 OR v_buffer < 0 THEN
      RETURN QUERY SELECT 'availability_unverified', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;

    IF p_booking_date IS NULL
       OR p_booking_date < (pg_catalog.transaction_timestamp() AT TIME ZONE v_timezone)::date
       OR coalesce(v_closed_dates, '[]'::jsonb) ? p_booking_date::text THEN
      RETURN QUERY SELECT 'slot_unavailable', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;

    v_day_key := (ARRAY['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[
      extract(dow FROM p_booking_date)::integer + 1
    ];
    v_day := coalesce(v_opening_hours, '{}'::jsonb) -> v_day_key;
    IF v_day IS NULL
       OR coalesce((v_day ->> 'closed')::boolean, false)
       OR coalesce(v_day ->> 'open', '') !~ '^[0-2][0-9]:[0-5][0-9]$'
       OR coalesce(v_day ->> 'close', '') !~ '^[0-2][0-9]:[0-5][0-9]$' THEN
      RETURN QUERY SELECT 'slot_unavailable', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;

    v_open_min := pg_catalog.split_part(v_day ->> 'open', ':', 1)::integer * 60
      + pg_catalog.split_part(v_day ->> 'open', ':', 2)::integer;
    v_close_min := pg_catalog.split_part(v_day ->> 'close', ':', 1)::integer * 60
      + pg_catalog.split_part(v_day ->> 'close', ':', 2)::integer;
    IF v_open_min < 0 OR v_close_min > 1440 OR v_open_min >= v_close_min THEN
      RETURN QUERY SELECT 'availability_unverified', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;

    IF v_requested_label IS NOT NULL THEN
      v_match := pg_catalog.regexp_match(
        pg_catalog.upper(v_requested_label),
        '^([0-9]{1,2}):([0-9]{2})[[:space:]]+(AM|PM)$'
      );
      IF v_match IS NULL THEN
        RETURN QUERY SELECT 'availability_unverified', NULL::text, 0, 0, 0, 0;
        RETURN;
      END IF;
      v_hour := v_match[1]::integer;
      v_minute := v_match[2]::integer;
      v_ampm := v_match[3];
      IF v_hour NOT BETWEEN 1 AND 12 OR v_minute NOT BETWEEN 0 AND 59 THEN
        RETURN QUERY SELECT 'availability_unverified', NULL::text, 0, 0, 0, 0;
        RETURN;
      END IF;
      v_requested_min := (v_hour % 12) * 60 + v_minute
        + CASE WHEN v_ampm = 'PM' THEN 720 ELSE 0 END;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.staff_services AS ss
      JOIN public.staff AS person ON person.id = ss.staff_id
      WHERE person.salon_id = p_salon_id
        AND person.status = 'active'
        AND person.deleted_at IS NULL
    ) INTO v_has_capability_rows;

    SELECT count(*)::integer
    INTO v_eligible_staff
    FROM public.staff AS person
    WHERE person.salon_id = p_salon_id
      AND person.status = 'active'
      AND person.deleted_at IS NULL
      AND (p_staff_id IS NULL OR person.id = p_staff_id)
      AND (
        NOT v_has_capability_rows
        OR EXISTS (
          SELECT 1 FROM public.staff_services AS ss
          WHERE ss.staff_id = person.id AND ss.service_id = p_service_id
        )
      );

    IF v_eligible_staff = 0 THEN
      RETURN QUERY SELECT 'slot_unavailable', NULL::text, 0, 0, 0, 0;
      RETURN;
    END IF;

    v_requires_resource := v_resources_enabled AND v_resource_mode <> 'none';
    IF v_requires_resource THEN
      SELECT count(*)::integer
      INTO v_eligible_resources
      FROM public.salon_resources AS resource
      WHERE resource.salon_id = p_salon_id
        AND resource.status = 'active'
        AND resource.deleted_at IS NULL
        AND (
          v_resource_mode <> 'specific'
          OR resource.kind = ANY(v_required_kinds)
        );
      IF v_eligible_resources = 0 THEN
        RETURN QUERY SELECT
          'slot_unavailable', NULL::text, v_eligible_staff, 0, 0, 0;
        RETURN;
      END IF;
    END IF;

    FOR v_candidate_min IN
      SELECT DISTINCT candidate.minute_value
      FROM (
        SELECT v_requested_min AS minute_value
        WHERE v_requested_label IS NOT NULL
        UNION ALL
        SELECT grid.minute_value
        FROM pg_catalog.generate_series(
          v_open_min,
          v_close_min - v_duration,
          15
        ) AS grid(minute_value)
        WHERE v_requested_label IS NULL
        UNION ALL
        SELECT (
          extract(hour FROM occupied.local_end)::integer * 60
          + extract(minute FROM occupied.local_end)::integer
        ) AS minute_value
        FROM (
          SELECT b.end_time_utc AT TIME ZONE v_timezone AS local_end
          FROM public.bookings AS b
          WHERE b.salon_id = p_salon_id
            AND b.deleted_at IS NULL
            AND b.status NOT IN ('cancelled', 'waiting', 'no_show', 'completed')
            AND (b.end_time_utc AT TIME ZONE v_timezone)::date = p_booking_date
          UNION ALL
          SELECT seg.occupied_end_utc AT TIME ZONE v_timezone AS local_end
          FROM public.booking_service_segments AS seg
          WHERE seg.salon_id = p_salon_id
            AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
            AND (seg.occupied_end_utc AT TIME ZONE v_timezone)::date = p_booking_date
        ) AS occupied
        WHERE v_requested_label IS NULL
      ) AS candidate
      WHERE candidate.minute_value IS NOT NULL
        AND candidate.minute_value >= v_open_min
        AND candidate.minute_value + v_duration <= v_close_min
      ORDER BY candidate.minute_value
    LOOP
      v_candidate_start := (
        p_booking_date::timestamp
        + pg_catalog.make_interval(mins => v_candidate_min)
      ) AT TIME ZONE v_timezone;
      v_customer_end := v_candidate_start
        + pg_catalog.make_interval(mins => v_duration);
      v_candidate_end := v_customer_end
        + pg_catalog.make_interval(mins => v_buffer);

      IF p_booking_date = (pg_catalog.transaction_timestamp() AT TIME ZONE v_timezone)::date
         AND v_candidate_start < pg_catalog.transaction_timestamp()
           + pg_catalog.make_interval(mins => v_lead_minutes) THEN
        CONTINUE;
      END IF;

      v_seen_candidate := true;

      SELECT count(*)::integer
      INTO v_free_staff
      FROM public.staff AS person
      WHERE person.salon_id = p_salon_id
        AND person.status = 'active'
        AND person.deleted_at IS NULL
        AND (p_staff_id IS NULL OR person.id = p_staff_id)
        AND (
          NOT v_has_capability_rows
          OR EXISTS (
            SELECT 1 FROM public.staff_services AS ss
            WHERE ss.staff_id = person.id AND ss.service_id = p_service_id
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_unavailability AS unavailable
          WHERE unavailable.salon_id = p_salon_id
            AND unavailable.staff_id = person.id
            AND unavailable.date = p_booking_date
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM public.staff_shifts AS any_shift
            WHERE any_shift.salon_id = p_salon_id
              AND any_shift.staff_id = person.id
              AND any_shift.day_of_week = v_day_key
              AND any_shift.is_active
          )
          OR EXISTS (
            SELECT 1 FROM public.staff_shifts AS shift
            WHERE shift.salon_id = p_salon_id
              AND shift.staff_id = person.id
              AND shift.day_of_week = v_day_key
              AND shift.is_active
              AND shift.start_time::time <= (v_candidate_start AT TIME ZONE v_timezone)::time
              AND shift.end_time::time >= (v_candidate_end AT TIME ZONE v_timezone)::time
              AND NOT (
                shift.break_start_time IS NOT NULL
                AND shift.break_end_time IS NOT NULL
                AND (v_candidate_start AT TIME ZONE v_timezone)::time < shift.break_end_time
                AND (v_candidate_end AT TIME ZONE v_timezone)::time > shift.break_start_time
              )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.bookings AS existing
          WHERE existing.salon_id = p_salon_id
            AND existing.staff_id = person.id
            AND existing.deleted_at IS NULL
            AND existing.status NOT IN ('cancelled', 'waiting', 'no_show', 'completed')
            AND existing.start_time_utc < v_candidate_end
            AND existing.end_time_utc > v_candidate_start
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.booking_service_segments AS segment
          WHERE segment.salon_id = p_salon_id
            AND segment.staff_id = person.id
            AND segment.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
            AND segment.occupied_start_utc < v_candidate_end
            AND segment.occupied_end_utc > v_candidate_start
        );

      IF v_requires_resource THEN
        SELECT count(*)::integer
        INTO v_free_resources
        FROM public.salon_resources AS resource
        WHERE resource.salon_id = p_salon_id
          AND resource.status = 'active'
          AND resource.deleted_at IS NULL
          AND (
            v_resource_mode <> 'specific'
            OR resource.kind = ANY(v_required_kinds)
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.bookings AS existing
            WHERE existing.salon_id = p_salon_id
              AND existing.resource_id = resource.id
              AND existing.deleted_at IS NULL
              AND existing.status NOT IN ('cancelled', 'waiting', 'no_show', 'completed')
              AND existing.start_time_utc < v_candidate_end
              AND existing.end_time_utc > v_candidate_start
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.booking_service_segments AS segment
            WHERE segment.salon_id = p_salon_id
              AND segment.resource_id = resource.id
              AND segment.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
              AND segment.occupied_start_utc < v_candidate_end
              AND segment.occupied_end_utc > v_candidate_start
          );
      ELSE
        v_free_resources := 0;
      END IF;

      IF NOT v_seen_candidate OR v_first_free_staff = 0 THEN
        v_first_free_staff := v_free_staff;
        v_first_free_resources := v_free_resources;
      END IF;

      IF v_free_staff > 0 AND (NOT v_requires_resource OR v_free_resources > 0) THEN
        v_hour := (v_candidate_min / 60) % 12;
        IF v_hour = 0 THEN v_hour := 12; END IF;
        RETURN QUERY SELECT
          'slot_available',
          v_hour::text || ':' || pg_catalog.lpad((v_candidate_min % 60)::text, 2, '0')
            || CASE WHEN v_candidate_min < 720 THEN ' AM' ELSE ' PM' END,
          v_eligible_staff,
          v_eligible_resources,
          v_free_staff,
          v_free_resources;
        RETURN;
      END IF;
    END LOOP;

    RETURN QUERY SELECT
      'slot_unavailable', NULL::text, v_eligible_staff, v_eligible_resources,
      CASE WHEN v_seen_candidate THEN v_first_free_staff ELSE 0 END,
      CASE WHEN v_seen_candidate THEN v_first_free_resources ELSE 0 END;
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT
      'availability_unverified', NULL::text,
      coalesce(v_eligible_staff, 0), coalesce(v_eligible_resources, 0), 0, 0;
    RETURN;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.evaluate_individual_waitlist_capacity(
  uuid, uuid, uuid, date, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_individual_waitlist_capacity(
  uuid, uuid, uuid, date, text
) TO service_role;

COMMENT ON FUNCTION public.evaluate_individual_waitlist_capacity(
  uuid, uuid, uuid, date, text
) IS 'Fail-closed individual waitlist capacity evaluator with no customer PII input or output.';

CREATE OR REPLACE FUNCTION public.reject_false_individual_waitlist_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_capacity record;
BEGIN
  IF NEW.request_kind <> 'individual' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_capacity
  FROM public.evaluate_individual_waitlist_capacity(
    NEW.salon_id,
    NEW.service_id,
    NEW.staff_id,
    NEW.booking_date,
    NEW.preferred_slot_label
  );

  IF v_capacity.outcome = 'slot_available' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'slot_available';
  END IF;
  IF v_capacity.outcome <> 'slot_unavailable' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001', MESSAGE = 'availability_unverified';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.reject_false_individual_waitlist_entry()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS reject_false_individual_waitlist_entry
  ON public.booking_waitlist_entries;
CREATE TRIGGER reject_false_individual_waitlist_entry
BEFORE INSERT ON public.booking_waitlist_entries
FOR EACH ROW
EXECUTE FUNCTION public.reject_false_individual_waitlist_entry();

CREATE OR REPLACE FUNCTION public.create_public_capacity_rescue_request_v2(
  p_salon_id uuid,
  p_request_id uuid,
  p_request_kind text,
  p_primary_service_id uuid,
  p_staff_id uuid,
  p_booking_date date,
  p_preferred_slot_label text,
  p_party_size integer,
  p_client_name text,
  p_client_phone text,
  p_client_email text,
  p_client_locale text,
  p_intent_json jsonb,
  p_app_version text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  status text,
  created_new boolean,
  guard_outcome text,
  slot_label text,
  eligible_staff_count integer,
  eligible_resource_count integer,
  free_staff_count integer,
  free_resource_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_request_kind, '')));
  v_capacity record;
  v_result record;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  -- Preserve request-id idempotency even if capacity changed after the first
  -- durable receipt. The legacy function still performs the full fingerprint
  -- comparison, so a changed payload cannot reuse the receipt.
  IF EXISTS (
    SELECT 1 FROM public.booking_waitlist_entries AS existing
    WHERE existing.salon_id = p_salon_id
      AND existing.request_id = p_request_id
  ) THEN
    SELECT * INTO v_result
    FROM public.create_public_capacity_rescue_request(
      p_salon_id, p_request_id, p_request_kind, p_primary_service_id,
      p_staff_id, p_booking_date, p_preferred_slot_label, p_party_size,
      p_client_name, p_client_phone, p_client_email, p_client_locale,
      p_intent_json
    );

    INSERT INTO public.capacity_rescue_decision_events (
      salon_id, request_id, waitlist_entry_id, decision_source, request_kind,
      service_id, staff_id, booking_date, preferred_slot_label, outcome,
      reason_code, app_version
    ) VALUES (
      p_salon_id, p_request_id, v_result.id, 'database_guard', v_kind,
      p_primary_service_id, p_staff_id, p_booking_date,
      nullif(pg_catalog.btrim(coalesce(p_preferred_slot_label, '')), ''),
      'idempotent', 'request_id_retry',
      nullif(pg_catalog.btrim(coalesce(p_app_version, '')), '')
    );

    RETURN QUERY SELECT
      v_result.id, v_result.status, false,
      CASE WHEN v_kind = 'individual' THEN 'slot_unavailable' ELSE 'capacity_not_applicable' END,
      NULL::text, NULL::integer, NULL::integer, NULL::integer, NULL::integer;
    RETURN;
  END IF;

  IF v_kind = 'individual' THEN
    SELECT * INTO v_capacity
    FROM public.evaluate_individual_waitlist_capacity(
      p_salon_id,
      p_primary_service_id,
      p_staff_id,
      p_booking_date,
      p_preferred_slot_label
    );

    IF v_capacity.outcome <> 'slot_unavailable' THEN
      INSERT INTO public.capacity_rescue_decision_events (
        salon_id, request_id, decision_source, request_kind, service_id,
        staff_id, booking_date, preferred_slot_label, outcome, reason_code,
        eligible_staff_count, eligible_resource_count,
        free_staff_count, free_resource_count, app_version
      ) VALUES (
        p_salon_id, p_request_id, 'database_guard', v_kind,
        p_primary_service_id, p_staff_id, p_booking_date,
        nullif(pg_catalog.btrim(coalesce(p_preferred_slot_label, '')), ''),
        v_capacity.outcome, v_capacity.outcome,
        v_capacity.eligible_staff_count, v_capacity.eligible_resource_count,
        v_capacity.free_staff_count, v_capacity.free_resource_count,
        nullif(pg_catalog.btrim(coalesce(p_app_version, '')), '')
      );

      RETURN QUERY SELECT
        NULL::uuid, NULL::text, false, v_capacity.outcome,
        v_capacity.slot_label, v_capacity.eligible_staff_count,
        v_capacity.eligible_resource_count, v_capacity.free_staff_count,
        v_capacity.free_resource_count;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO v_result
  FROM public.create_public_capacity_rescue_request(
    p_salon_id, p_request_id, p_request_kind, p_primary_service_id,
    p_staff_id, p_booking_date, p_preferred_slot_label, p_party_size,
    p_client_name, p_client_phone, p_client_email, p_client_locale,
    p_intent_json
  );

  INSERT INTO public.capacity_rescue_decision_events (
    salon_id, request_id, waitlist_entry_id, decision_source, request_kind,
    service_id, staff_id, booking_date, preferred_slot_label, outcome,
    reason_code, eligible_staff_count, eligible_resource_count,
    free_staff_count, free_resource_count, app_version
  ) VALUES (
    p_salon_id, p_request_id, v_result.id, 'database_guard', v_kind,
    p_primary_service_id, p_staff_id, p_booking_date,
    nullif(pg_catalog.btrim(coalesce(p_preferred_slot_label, '')), ''),
    CASE WHEN v_result.created_new THEN 'created' ELSE 'idempotent' END,
    CASE WHEN v_kind = 'individual' THEN 'slot_unavailable' ELSE 'capacity_not_applicable' END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.eligible_staff_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.eligible_resource_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.free_staff_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.free_resource_count ELSE NULL END,
    nullif(pg_catalog.btrim(coalesce(p_app_version, '')), '')
  );

  RETURN QUERY SELECT
    v_result.id, v_result.status, v_result.created_new,
    CASE WHEN v_kind = 'individual' THEN 'slot_unavailable' ELSE 'capacity_not_applicable' END,
    NULL::text,
    CASE WHEN v_kind = 'individual' THEN v_capacity.eligible_staff_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.eligible_resource_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.free_staff_count ELSE NULL END,
    CASE WHEN v_kind = 'individual' THEN v_capacity.free_resource_count ELSE NULL END;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_public_capacity_rescue_request_v2(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_capacity_rescue_request_v2(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb, text
) TO service_role;

COMMENT ON FUNCTION public.create_public_capacity_rescue_request_v2(
  uuid, uuid, text, uuid, uuid, date, text, integer,
  text, text, text, text, jsonb, text
) IS 'Atomic service-role capacity rescue boundary. Individual waitlist insertion is rejected when capacity is open or cannot be proven closed.';

COMMIT;
