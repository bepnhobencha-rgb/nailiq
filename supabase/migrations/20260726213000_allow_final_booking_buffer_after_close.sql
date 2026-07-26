-- Closing-time parity for public + front-desk bookings.
--
-- Booking rows reserve the full service interval, including cleanup buffers.
-- The private legacy implementation compares that full stored end time with
-- salon close, which rejects a valid final appointment whose customer-facing
-- service finishes at close and whose cleanup buffer follows it.
--
-- Keep the private strict implementations unchanged. At the public boundary:
--   1. verify the caller's interval exactly matches authoritative service data;
--   2. validate/create using the customer-facing completion end; and
--   3. atomically restore the full buffered end for overlap protection.
--
-- This replaces the existing canonical function in-place, so the migration
-- does not add an RPC or widen the PostgREST surface.

CREATE OR REPLACE FUNCTION public.create_public_booking(
  p_salon_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_client_name text,
  p_client_phone text,
  p_start_time_utc timestamptz,
  p_end_time_utc timestamptz,
  p_status text DEFAULT 'pending',
  p_price_cents integer DEFAULT NULL,
  p_client_notes text DEFAULT NULL,
  p_addon_service_id uuid DEFAULT NULL,
  p_addon_price_cents integer DEFAULT NULL,
  p_client_email text DEFAULT NULL,
  p_resource_id uuid DEFAULT NULL
)
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
  v_digits text := regexp_replace(coalesce(p_client_phone, ''), '\D', '', 'g');
  v_phone_bucket text;
  v_result jsonb;
  v_booking_id uuid;
  v_main_duration integer;
  v_main_buffer integer;
  v_addon_duration integer := 0;
  v_addon_buffer integer := 0;
  v_addon_timing text := 'sequential';
  v_expected_block integer;
  v_trailing_buffer integer := 0;
  v_create_end timestamptz := p_end_time_utc;
  v_restore_buffered_end boolean := false;
BEGIN
  -- Preserve the existing abuse controls at the canonical public boundary.
  IF v_role = 'anon' THEN
    IF NOT public.rate_limit_hit(
      'public-booking:salon:' || coalesce(p_salon_id::text, 'missing'),
      30,
      600
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;

    v_phone_bucket :=
      md5(coalesce(p_salon_id::text, 'missing') || ':' || v_digits);
    IF NOT public.rate_limit_hit(
      'public-booking:phone:' || v_phone_bucket,
      3,
      900
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;
  END IF;

  -- Fail closed unless the supplied interval exactly matches authoritative
  -- service timing. Combo and multi-add-on calls naturally stay on the strict
  -- full-block path because their supplied end will not match this legacy
  -- single-add-on calculation.
  SELECT
    greatest(0, coalesce(s.duration_minutes, 0)),
    greatest(0, coalesce(s.buffer_minutes, 0))
  INTO v_main_duration, v_main_buffer
  FROM public.services s
  WHERE s.id = p_service_id
    AND s.salon_id = p_salon_id
    AND s.deleted_at IS NULL;

  IF FOUND AND v_main_duration > 0 THEN
    v_expected_block := v_main_duration + v_main_buffer;
    v_trailing_buffer := v_main_buffer;

    IF p_addon_service_id IS NOT NULL THEN
      SELECT
        greatest(0, coalesce(s.duration_minutes, 0)),
        greatest(0, coalesce(s.buffer_minutes, 0)),
        coalesce(s.addon_timing, 'sequential')
      INTO v_addon_duration, v_addon_buffer, v_addon_timing
      FROM public.services s
      WHERE s.id = p_addon_service_id
        AND s.salon_id = p_salon_id
        AND s.deleted_at IS NULL
        AND s.is_addon IS TRUE;

      IF NOT FOUND OR v_addon_duration < 1 THEN
        v_trailing_buffer := 0;
      ELSIF v_addon_timing <> 'concurrent' THEN
        v_expected_block :=
          v_expected_block + v_addon_duration + v_addon_buffer;
        v_trailing_buffer := v_addon_buffer;
      END IF;
    END IF;

    IF v_trailing_buffer > 0
       AND p_end_time_utc =
         p_start_time_utc + make_interval(mins => v_expected_block) THEN
      v_create_end :=
        p_end_time_utc - make_interval(mins => v_trailing_buffer);
      v_restore_buffered_end := true;
    END IF;
  END IF;

  BEGIN
    IF to_regprocedure(
      'public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
    ) IS NOT NULL THEN
      EXECUTE 'SELECT public.create_public_booking_unlimited_14($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)'
        INTO v_result
        USING p_salon_id, p_service_id, p_staff_id, p_client_name,
          p_client_phone, p_start_time_utc, v_create_end, p_status,
          p_price_cents, p_client_notes, p_addon_service_id,
          p_addon_price_cents, p_client_email, p_resource_id;
    ELSE
      EXECUTE 'SELECT public.create_public_booking_unlimited_13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)'
        INTO v_result
        USING p_salon_id, p_service_id, p_staff_id, p_client_name,
          p_client_phone, p_start_time_utc, v_create_end, p_status,
          p_price_cents, p_client_notes, p_addon_service_id,
          p_addon_price_cents, p_client_email;
    END IF;

    IF NOT v_restore_buffered_end
       OR coalesce(v_result->>'success', 'false') <> 'true' THEN
      RETURN v_result;
    END IF;

    v_booking_id := nullif(v_result->>'booking_id', '')::uuid;
    UPDATE public.bookings
    SET end_time_utc = p_end_time_utc
    WHERE id = v_booking_id
      AND salon_id = p_salon_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'booking_not_found_after_create';
    END IF;

    RETURN jsonb_set(
      v_result,
      '{end_time_utc}',
      to_jsonb(p_end_time_utc),
      true
    );
  EXCEPTION
    -- The update re-checks staff/resource GiST exclusions using the full
    -- buffered interval. This subtransaction rolls back the temporary insert.
    WHEN exclusion_violation THEN
      RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) TO anon, service_role;

COMMENT ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) IS
  'Public booking boundary: service work must finish by close; final cleanup buffer may follow close while the full interval remains conflict-protected.';
