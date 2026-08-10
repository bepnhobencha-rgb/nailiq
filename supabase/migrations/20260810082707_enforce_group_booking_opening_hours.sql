-- P1 safety boundary: every public/Voice/SMS group-booking write must remain
-- inside the salon's configured opening hours. Application schedulers already
-- filter availability, but this SECURITY DEFINER function is reachable by the
-- anonymous client and therefore must verify the policy independently.
--
-- The customer-facing service span must finish by close. Only the final
-- cleanup/reset buffer may extend past close, matching the individual booking
-- timing model. The new addon_service_ids payload key lets the database derive
-- all sequential add-on timing authoritatively. Legacy callers remain safe:
-- if their occupied block is longer than the known catalog block, the unknown
-- remainder is treated as customer service time (fail closed at closing).

CREATE OR REPLACE FUNCTION public.insert_group_bookings(p_bookings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_group_size integer;
  v_booking jsonb;
  v_salon_id uuid;
  v_row_salon_id uuid;
  v_service_id uuid;
  v_staff_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_price integer;
  v_service_duration integer;
  v_service_buffer integer;
  v_authoritative_block integer;
  v_trailing_buffer integer;
  v_service_completion integer;
  v_actual_block_seconds numeric;
  v_addon_ids jsonb;
  v_addon_text text;
  v_addon_id uuid;
  v_addon_duration integer;
  v_addon_buffer integer;
  v_addon_timing text;
  v_hours jsonb;
  v_closed_dates jsonb;
  v_tz_raw text;
  v_tz text;
  v_start_local timestamp;
  v_end_local timestamp;
  v_completion_local timestamp;
  v_day text;
  v_day_cfg jsonb;
  v_ymd text;
  v_open time;
  v_close time;
  v_digits text;
  v_phone_bucket text;
  v_sanitized jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_bookings) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  v_group_size := jsonb_array_length(p_bookings);
  IF v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  FOR v_booking IN SELECT value FROM jsonb_array_elements(p_bookings)
  LOOP
    BEGIN
      v_row_salon_id := (v_booking->>'salon_id')::uuid;
      v_service_id := (v_booking->>'service_id')::uuid;
      v_staff_id := (v_booking->>'staff_id')::uuid;
      v_start := (v_booking->>'start_time_utc')::timestamptz;
      v_end := (v_booking->>'end_time_utc')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END;

    IF v_salon_id IS NULL THEN
      v_salon_id := v_row_salon_id;

      SELECT
        s.opening_hours,
        coalesce(s.booking_closed_dates, '[]'::jsonb),
        coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles')
      INTO v_hours, v_closed_dates, v_tz_raw
      FROM public.salons s
      WHERE s.id = v_salon_id;

      IF NOT FOUND OR v_hours IS NULL OR v_hours = '{}'::jsonb THEN
        RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
      END IF;

      IF EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = v_tz_raw) THEN
        v_tz := v_tz_raw;
      ELSE
        RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
      END IF;
    END IF;

    IF v_row_salon_id IS NULL OR v_row_salon_id <> v_salon_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
    END IF;

    SELECT
      s.price_cents,
      greatest(coalesce(s.duration_minutes, 0), 0),
      greatest(coalesce(s.buffer_minutes, 0), 0)
    INTO v_price, v_service_duration, v_service_buffer
    FROM public.services s
    WHERE s.id = v_service_id
      AND s.salon_id = v_salon_id
      AND s.deleted_at IS NULL
      AND NOT s.is_addon;
    IF NOT FOUND OR v_service_duration < 1 THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_service');
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.staff st
      WHERE st.id = v_staff_id
        AND st.salon_id = v_salon_id
        AND st.deleted_at IS NULL
        AND st.status = 'active'
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_staff');
    END IF;

    IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start
       OR v_end - v_start > interval '12 hours'
       OR v_start < now() - interval '15 minutes'
       OR v_start > now() + interval '1 year' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_time');
    END IF;

    IF length(trim(coalesce(v_booking->>'client_name', ''))) NOT BETWEEN 1 AND 120 THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_client_name');
    END IF;

    v_authoritative_block := v_service_duration + v_service_buffer;
    v_trailing_buffer := v_service_buffer;

    IF v_booking ? 'addon_service_ids' THEN
      v_addon_ids := v_booking->'addon_service_ids';
      IF jsonb_typeof(v_addon_ids) <> 'array' THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_addons');
      END IF;

      FOR v_addon_text IN SELECT value FROM jsonb_array_elements_text(v_addon_ids)
      LOOP
        BEGIN
          v_addon_id := v_addon_text::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('success', false, 'code', 'invalid_addons');
        END;

        SELECT
          greatest(coalesce(s.duration_minutes, 0), 0),
          greatest(coalesce(s.buffer_minutes, 0), 0),
          s.addon_timing
        INTO v_addon_duration, v_addon_buffer, v_addon_timing
        FROM public.services s
        WHERE s.id = v_addon_id
          AND s.salon_id = v_salon_id
          AND s.deleted_at IS NULL
          AND s.is_addon;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('success', false, 'code', 'invalid_addons');
        END IF;

        IF v_addon_timing <> 'concurrent' THEN
          v_authoritative_block :=
            v_authoritative_block + v_addon_duration + v_addon_buffer;
          v_trailing_buffer := v_addon_buffer;
        END IF;
      END LOOP;

      v_actual_block_seconds := extract(epoch FROM (v_end - v_start));
      IF abs(v_actual_block_seconds - (v_authoritative_block * 60)) > 1 THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_time');
      END IF;
      v_service_completion := v_authoritative_block - v_trailing_buffer;
    ELSE
      -- Backward-compatible safety for a stale browser. Validate the legacy
      -- first add-on when present. If the submitted block is longer than the
      -- known catalog block, treat the extra time as service rather than a
      -- cleanup buffer so the close-time check remains fail-closed.
      IF nullif(v_booking->>'addon_service_id', '') IS NOT NULL THEN
        BEGIN
          v_addon_id := (v_booking->>'addon_service_id')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN jsonb_build_object('success', false, 'code', 'invalid_addons');
        END;

        SELECT
          greatest(coalesce(s.duration_minutes, 0), 0),
          greatest(coalesce(s.buffer_minutes, 0), 0),
          s.addon_timing
        INTO v_addon_duration, v_addon_buffer, v_addon_timing
        FROM public.services s
        WHERE s.id = v_addon_id
          AND s.salon_id = v_salon_id
          AND s.deleted_at IS NULL
          AND s.is_addon;
        IF NOT FOUND THEN
          RETURN jsonb_build_object('success', false, 'code', 'invalid_addons');
        END IF;

        IF v_addon_timing <> 'concurrent' THEN
          v_authoritative_block :=
            v_authoritative_block + v_addon_duration + v_addon_buffer;
          v_trailing_buffer := v_addon_buffer;
        END IF;
      END IF;

      v_actual_block_seconds := extract(epoch FROM (v_end - v_start));
      IF v_actual_block_seconds + 1 < (v_authoritative_block * 60) THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_time');
      ELSIF abs(v_actual_block_seconds - (v_authoritative_block * 60)) <= 1 THEN
        v_service_completion := v_authoritative_block - v_trailing_buffer;
      ELSE
        v_service_completion := ceil(v_actual_block_seconds / 60.0)::integer;
      END IF;
    END IF;

    v_start_local := v_start AT TIME ZONE v_tz;
    v_end_local := v_end AT TIME ZONE v_tz;
    v_completion_local :=
      (v_start + make_interval(mins => v_service_completion)) AT TIME ZONE v_tz;

    IF date(v_start_local) <> date(v_end_local)
       OR date(v_start_local) <> date(v_completion_local) THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END IF;

    v_ymd := to_char(v_start_local, 'YYYY-MM-DD');
    IF jsonb_typeof(v_closed_dates) = 'array'
       AND EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(v_closed_dates) AS el(t)
         WHERE el.t = v_ymd
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END IF;

    v_day := CASE extract(dow FROM v_start_local)::integer
      WHEN 0 THEN 'sun'
      WHEN 1 THEN 'mon'
      WHEN 2 THEN 'tue'
      WHEN 3 THEN 'wed'
      WHEN 4 THEN 'thu'
      WHEN 5 THEN 'fri'
      WHEN 6 THEN 'sat'
      ELSE NULL
    END;
    v_day_cfg := v_hours -> v_day;

    IF v_day IS NULL
       OR jsonb_typeof(v_day_cfg) <> 'object'
       OR coalesce((v_day_cfg->>'closed')::boolean, false)
       OR nullif(trim(v_day_cfg->>'open'), '') IS NULL
       OR nullif(trim(v_day_cfg->>'close'), '') IS NULL THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END IF;

    BEGIN
      v_open := (v_day_cfg->>'open')::time;
      v_close := (v_day_cfg->>'close')::time;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END;

    IF v_close <= v_open
       OR v_start_local::time < v_open
       OR v_start_local::time >= v_close
       OR v_completion_local::time > v_close
       OR v_completion_local <= v_start_local THEN
      RETURN jsonb_build_object('success', false, 'code', 'outside_hours');
    END IF;

    -- Price remains derived from the salon's main service catalog. A modified
    -- browser payload cannot create a fake discounted booking snapshot.
    v_sanitized := v_sanitized || jsonb_build_array(
      (v_booking - 'addon_service_ids') || jsonb_build_object('price_cents', v_price)
    );
  END LOOP;

  IF v_role = 'anon' THEN
    IF NOT public.rate_limit_hit(
      'public-group-booking:salon:' || v_salon_id::text, 10, 600
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;

    v_digits := regexp_replace(coalesce(p_bookings->0->>'client_phone', ''), '\\D', '', 'g');
    v_phone_bucket := md5(v_salon_id::text || ':' || v_digits);
    IF NOT public.rate_limit_hit(
      'public-group-booking:phone:' || v_phone_bucket, 3, 900
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;
  END IF;

  RETURN public.insert_group_bookings_unlimited(v_sanitized);
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_group_bookings(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings(jsonb)
  TO anon, service_role;

COMMENT ON FUNCTION public.insert_group_bookings(jsonb) IS
  'Validated group-booking write boundary with authoritative catalog timing, opening-hours enforcement, prices, and anonymous abuse limits.';

-- Migration-time proof: keep this public write boundary SECURITY DEFINER with
-- an explicit search_path and least-privilege grants after every replacement.
DO $proof$
DECLARE
  v_is_definer boolean;
  v_config text[];
BEGIN
  SELECT p.prosecdef, p.proconfig
  INTO v_is_definer, v_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'insert_group_bookings'
    AND pg_get_function_identity_arguments(p.oid) = 'p_bookings jsonb';

  IF v_is_definer IS DISTINCT FROM true
     OR NOT ('search_path=public' = ANY(coalesce(v_config, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'insert_group_bookings security configuration drift';
  END IF;

  IF has_function_privilege('authenticated', 'public.insert_group_bookings(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.insert_group_bookings(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.insert_group_bookings(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'insert_group_bookings privilege configuration drift';
  END IF;
END;
$proof$;
