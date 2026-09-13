-- A booking contact challenge is not necessarily proof of phone ownership.
-- Never infer historical proof from delivery telemetry, profile email, or CRM links.
ALTER TABLE public.phone_otp_sessions
  ADD COLUMN verified_channel text NOT NULL DEFAULT 'legacy_unverified',
  ADD CONSTRAINT phone_otp_sessions_verified_channel_check CHECK (
    verified_channel IN ('sms', 'email', 'staff_attested', 'demo', 'legacy_unverified')
  );
COMMENT ON COLUMN public.phone_otp_sessions.verified_channel IS
  'Trusted issuer proof: only sms authorizes phone-owned profile/card access. Other approved channels permit a booking contact challenge only. Historical evidence stays untrusted.';

CREATE OR REPLACE FUNCTION public.validate_phone_otp_session(
  p_session_id uuid, p_salon_id uuid, p_phone text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.phone_otp_sessions s
    WHERE s.id = p_session_id
      AND s.salon_id = p_salon_id
      AND s.phone = pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
      AND s.verified_channel = 'sms'
      AND s.consumed_at IS NULL AND s.consumed_by_booking_id IS NULL
      AND s.expires_at > now()
  );
$function$;

CREATE FUNCTION public.validate_booking_otp_session(
  p_session_id uuid, p_salon_id uuid, p_phone text
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.phone_otp_sessions s
    WHERE s.id = p_session_id
      AND s.salon_id = p_salon_id
      AND s.phone = pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
      AND s.verified_channel IN ('sms', 'email', 'staff_attested', 'demo')
      AND s.consumed_at IS NULL AND s.consumed_by_booking_id IS NULL
      AND s.expires_at > now()
  );
$function$;
REVOKE ALL ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text),
  public.validate_booking_otp_session(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text),
  public.validate_booking_otp_session(uuid, uuid, text) TO anon, service_role;
COMMENT ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text) IS
  'Exact unconsumed SMS capability for phone ownership. Email, desk, demo and legacy sessions fail closed.';
COMMENT ON FUNCTION public.validate_booking_otp_session(uuid, uuid, text) IS
  'Exact unconsumed booking contact challenge. Must not authorize phone profile, saved card, voice or loyalty reads.';

-- Creating a booking under a claimed phone is not authority to read its CRM profile.
-- The two-argument server-only overload remains unchanged.
CREATE OR REPLACE FUNCTION public.get_booking_client_snapshot(
  p_salon_id uuid, p_phone text, p_booking_id uuid
) RETURNS TABLE(visit_count integer, name text, no_show_count integer, is_vip boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT cp.visit_count, cp.name, cp.no_show_count, cp.is_vip
  FROM public.bookings b
  JOIN public.phone_otp_sessions s ON s.id = b.otp_session_id
    AND s.verified_channel = 'sms'
    AND s.salon_id = b.salon_id
    AND public.canonical_phone(s.phone) = public.canonical_phone(b.client_phone)
    AND s.consumed_by_booking_id = b.id
    AND s.consumed_at IS NOT NULL
    AND pg_catalog.isfinite(s.consumed_at) AND pg_catalog.isfinite(s.verified_at)
    AND pg_catalog.isfinite(s.expires_at)
    AND s.consumed_at >= s.verified_at AND s.consumed_at < s.expires_at
    AND s.consumed_at <= clock_timestamp()
  JOIN public.client_profiles cp ON cp.deleted_at IS NULL
    AND (b.client_profile_id = cp.id OR b.client_phone = cp.phone)
    AND public.canonical_phone(cp.phone) = public.canonical_phone(b.client_phone)
  WHERE b.id = p_booking_id AND b.salon_id = p_salon_id
    AND b.created_at >= now() - interval '10 minutes'
    AND public.canonical_phone(b.client_phone) = public.canonical_phone(p_phone)
  LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  TO anon, service_role;
COMMENT ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid) IS
  'Recent-booking snapshot requires SMS phone proof consumed by this exact salon booking. Email/desk/demo/legacy proof never discloses CRM history.';

CREATE OR REPLACE FUNCTION public.finalize_public_booking_profile(
  p_booking_id uuid, p_otp_session_id uuid DEFAULT NULL,
  p_marketing_consent boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_booking public.bookings%ROWTYPE;
  v_session public.phone_otp_sessions%ROWTYPE;
  v_phone_owner boolean := false;
BEGIN
  SELECT b.* INTO v_booking FROM public.bookings b
  WHERE b.id = p_booking_id AND b.created_at >= v_now - interval '10 minutes'
    AND b.status IN ('pending', 'confirmed')
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_booking');
  END IF;

  IF v_booking.client_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.client_profiles cp
    WHERE cp.id = v_booking.client_profile_id AND cp.deleted_at IS NULL
      AND public.canonical_phone(cp.phone) = public.canonical_phone(v_booking.client_phone)
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'profile_mismatch');
  END IF;

  IF p_otp_session_id IS NOT NULL THEN
    SELECT s.* INTO v_session FROM public.phone_otp_sessions s
    WHERE s.id = p_otp_session_id AND s.salon_id = v_booking.salon_id
      AND public.canonical_phone(s.phone) = public.canonical_phone(v_booking.client_phone)
      AND s.verified_channel IN ('sms', 'email', 'staff_attested', 'demo')
      AND s.expires_at > v_now
      AND (v_booking.otp_session_id IS NULL OR v_booking.otp_session_id = s.id)
      AND (
        (s.consumed_at IS NULL AND s.consumed_by_booking_id IS NULL)
        OR (s.consumed_at IS NOT NULL AND s.consumed_by_booking_id = v_booking.id
            AND v_booking.otp_session_id = s.id)
      )
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_otp_session');
    END IF;
    v_phone_owner := v_session.verified_channel = 'sms';
  END IF;

  -- CRM association is not authentication. Only present SMS proof may stamp
  -- global phone ownership or global marketing consent on this phone profile.
  IF v_phone_owner THEN
    UPDATE public.client_profiles cp SET
      phone_verified_at = CASE
        WHEN cp.phone_verified_at IS NULL OR cp.phone_verified_at < v_session.verified_at
          THEN v_session.verified_at ELSE cp.phone_verified_at END,
      marketing_consent_at = CASE
        WHEN p_marketing_consent THEN v_now ELSE cp.marketing_consent_at END
    WHERE cp.id = v_booking.client_profile_id;
  END IF;

  IF p_otp_session_id IS NOT NULL THEN
    UPDATE public.bookings SET verification_method = 'otp',
      verification_completed_at = coalesce(verification_completed_at, v_session.verified_at),
      otp_session_id = v_session.id WHERE id = v_booking.id;
    UPDATE public.phone_otp_sessions SET consumed_at = coalesce(consumed_at, v_now),
      consumed_by_booking_id = v_booking.id WHERE id = v_session.id;
  END IF;
  RETURN jsonb_build_object('success', true,
    'otp_stamped', p_otp_session_id IS NOT NULL,
    'marketing_consent_stamped', p_marketing_consent AND v_phone_owner);
END;
$function$;
REVOKE ALL ON FUNCTION public.finalize_public_booking_profile(uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_public_booking_profile(uuid, uuid, boolean)
  TO anon, service_role;

-- Preserve large atomic booking engines and every committed-replay branch.
-- Abort on schema drift instead of silently patching a different failure path.
DO $migration$
DECLARE
  v_name text;
  v_def text;
  v_old text;
  v_new text;
  v_profile_start integer;
  v_profile_end integer;
  v_profile_block text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'public.create_public_booking_sequence(jsonb)',
    'public.create_public_group_booking_sequences(jsonb)'
  ] LOOP
    IF to_regprocedure(v_name) IS NULL THEN
      RAISE EXCEPTION 'OTP authority migration missing function: %', v_name;
    END IF;
    v_def := pg_get_functiondef(to_regprocedure(v_name));
    v_old := 'OR v_otp_session.verified_at IS NULL';
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'OTP authority validation anchor mismatch: %', v_name;
    END IF;
    v_new := v_old || E'\n       OR v_otp_session.verified_channel NOT IN (''sms'', ''email'', ''staff_attested'', ''demo'')';
    v_def := replace(v_def, v_old, v_new);

    v_old := '      UPDATE public.client_profiles cp' || E'\n' || '      SET phone_verified_at = CASE';
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'OTP authority profile anchor mismatch: %', v_name;
    END IF;
    v_profile_start := strpos(v_def, v_old);
    v_old := CASE WHEN v_name = 'public.create_public_booking_sequence(jsonb)'
      THEN E'        RAISE EXCEPTION ''sequence OTP profile invariant failed'';\n      END IF;'
      ELSE E'        RAISE EXCEPTION ''group sequence OTP profile invariant failed'';\n      END IF;' END;
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1
      OR strpos(v_def, v_old) < v_profile_start THEN
      RAISE EXCEPTION 'OTP authority profile invariant mismatch: %', v_name;
    END IF;
    v_profile_end := strpos(v_def, v_old) + length(v_old);
    v_profile_block := substr(v_def, v_profile_start, v_profile_end - v_profile_start);
    v_def := replace(v_def, v_profile_block,
      E'      IF v_otp_session.verified_channel = ''sms'' THEN\n' || v_profile_block || E'\n      END IF;');
    EXECUTE v_def;
  END LOOP;
END;
$migration$;

-- Legacy server-only confirmer is a phone-identity action, not an email fallback.
CREATE OR REPLACE FUNCTION public.confirm_booking_with_otp(
  p_booking_id uuid, p_otp_session_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_session public.phone_otp_sessions%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
BEGIN
  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'phone_mismatch');
  END IF;
  SELECT * INTO v_session FROM public.phone_otp_sessions
  WHERE id = p_otp_session_id AND verified_channel = 'sms'
    AND salon_id = v_booking.salon_id
    AND public.canonical_phone(phone) = public.canonical_phone(v_booking.client_phone)
    AND consumed_at IS NULL AND consumed_by_booking_id IS NULL AND expires_at > now()
    AND (v_booking.otp_session_id IS NULL OR v_booking.otp_session_id = id)
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'otp_invalid_or_expired');
  END IF;
  UPDATE public.phone_otp_sessions SET consumed_at = now(),
    consumed_by_booking_id = p_booking_id WHERE id = p_otp_session_id;
  UPDATE public.bookings SET status = 'confirmed', verification_method = 'otp',
    verification_completed_at = now(), otp_session_id = p_otp_session_id,
    confirmed_at = now() WHERE id = p_booking_id;
  INSERT INTO public.booking_events(booking_id, salon_id, event_type, payload)
  VALUES(p_booking_id, v_booking.salon_id, 'verified_via_otp',
    jsonb_build_object('otp_session_id', p_otp_session_id));
  RETURN jsonb_build_object('ok', true, 'booking_id', p_booking_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.confirm_booking_with_otp(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_booking_with_otp(uuid, uuid) TO service_role;
