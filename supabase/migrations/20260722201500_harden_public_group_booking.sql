-- The anonymous group-booking RPC was a SECURITY DEFINER write boundary but
-- trusted caller-supplied salon/staff/service relationships and price values,
-- and it did not share the abuse controls used by single bookings.

ALTER FUNCTION public.insert_group_bookings(jsonb)
  RENAME TO insert_group_bookings_unlimited;

REVOKE ALL ON FUNCTION public.insert_group_bookings_unlimited(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings_unlimited(jsonb)
  TO service_role;

CREATE FUNCTION public.insert_group_bookings(p_bookings jsonb)
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

    IF v_salon_id IS NULL THEN v_salon_id := v_row_salon_id; END IF;
    IF v_row_salon_id IS NULL OR v_row_salon_id <> v_salon_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_salon');
    END IF;

    SELECT s.price_cents INTO v_price
    FROM public.services s
    WHERE s.id = v_service_id AND s.salon_id = v_salon_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_service');
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.id = v_staff_id AND st.salon_id = v_salon_id
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

    -- Price is always derived from the salon's service catalog. A modified
    -- browser payload cannot create a fake discounted booking snapshot.
    v_sanitized := v_sanitized || jsonb_build_array(
      v_booking || jsonb_build_object('price_cents', v_price)
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

REVOKE ALL ON FUNCTION public.insert_group_bookings(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings(jsonb)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.insert_group_bookings(jsonb) IS
  'Validated group-booking write boundary with authoritative prices and anonymous abuse limits.';
