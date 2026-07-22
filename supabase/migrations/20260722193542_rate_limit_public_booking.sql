-- Put abuse controls at the actual public write boundary. The browser calls
-- this RPC directly, so a Vercel proxy/WAF rule cannot see booking submits.
--
-- Drift compatibility: production currently has the 14-argument resource-aware
-- v2.9 implementation, while a clean replay of the repository ends at the
-- 13-argument implementation. Preserve whichever canonical implementation is
-- present behind a private name, then expose exactly one 14-argument wrapper.

DO $migration$
BEGIN
  IF to_regprocedure(
    'public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
  ) IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid) RENAME TO create_public_booking_unlimited_14';
  ELSIF to_regprocedure(
    'public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text)'
  ) IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.create_public_booking(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text) RENAME TO create_public_booking_unlimited_13';
  ELSE
    RAISE EXCEPTION 'No canonical create_public_booking implementation found';
  END IF;
END;
$migration$;

DO $migration$
BEGIN
  IF to_regprocedure(
    'public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
  ) IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid) TO service_role';
  ELSE
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_public_booking_unlimited_13(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.create_public_booking_unlimited_13(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text) TO service_role';
  END IF;
END;
$migration$;

CREATE FUNCTION public.create_public_booking(
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
BEGIN
  -- Anonymous public traffic is limited here. Authenticated salon staff and
  -- service-role server flows must remain available for front-desk operations.
  IF v_role = 'anon' THEN
    -- 30 per ten minutes still permits 180 legitimate public bookings/hour.
    IF NOT public.rate_limit_hit(
      'public-booking:salon:' || coalesce(p_salon_id::text, 'missing'),
      30,
      600
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;

    -- Store only a one-way phone-derived bucket, never the customer phone.
    v_phone_bucket := md5(coalesce(p_salon_id::text, 'missing') || ':' || v_digits);
    IF NOT public.rate_limit_hit(
      'public-booking:phone:' || v_phone_bucket,
      3,
      900
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'rate_limited');
    END IF;
  END IF;

  IF to_regprocedure(
    'public.create_public_booking_unlimited_14(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,integer,text,uuid,integer,text,uuid)'
  ) IS NOT NULL THEN
    EXECUTE 'SELECT public.create_public_booking_unlimited_14($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)'
      INTO v_result
      USING p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone,
        p_start_time_utc, p_end_time_utc, p_status, p_price_cents,
        p_client_notes, p_addon_service_id, p_addon_price_cents,
        p_client_email, p_resource_id;
  ELSE
    EXECUTE 'SELECT public.create_public_booking_unlimited_13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)'
      INTO v_result
      USING p_salon_id, p_service_id, p_staff_id, p_client_name, p_client_phone,
        p_start_time_utc, p_end_time_utc, p_status, p_price_cents,
        p_client_notes, p_addon_service_id, p_addon_price_cents, p_client_email;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.create_public_booking(
  uuid, uuid, uuid, text, text, timestamptz, timestamptz,
  text, integer, text, uuid, integer, text, uuid
) IS 'Public booking boundary with anonymous per-salon and per-phone abuse limits.';
