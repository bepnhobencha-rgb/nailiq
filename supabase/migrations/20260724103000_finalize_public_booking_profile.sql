-- Finalize the customer identity evidence attached to a newly-created public
-- booking without reopening direct client_profiles access.
--
-- The browser previously attempted two direct upserts:
--   * phone_verified_at after an OTP-backed booking
--   * marketing_consent_at after the customer ticked the consent box
-- Both writes are correctly denied by client_profiles RLS and therefore never
-- persisted. Group bookings also consumed the organizer OTP without stamping
-- the durable profile at all.
--
-- The unguessable booking id is the public capability. It is valid only for a
-- recent committed booking, and OTP evidence must independently match that
-- booking's salon and canonical phone. OTP consumption, booking evidence and
-- profile evidence are committed together.

CREATE FUNCTION public.finalize_public_booking_profile(
  p_booking_id uuid,
  p_otp_session_id uuid DEFAULT NULL,
  p_marketing_consent boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_booking public.bookings%ROWTYPE;
  v_session public.phone_otp_sessions%ROWTYPE;
BEGIN
  SELECT b.*
  INTO v_booking
  FROM public.bookings b
  WHERE b.id = p_booking_id
    AND b.created_at >= v_now - interval '10 minutes'
    AND b.status IN ('pending', 'confirmed')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'invalid_booking'
    );
  END IF;

  IF v_booking.client_profile_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.client_profiles cp
    WHERE cp.id = v_booking.client_profile_id
      AND cp.deleted_at IS NULL
      AND public.canonical_phone(cp.phone)
          = public.canonical_phone(v_booking.client_phone)
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'profile_mismatch'
    );
  END IF;

  IF p_otp_session_id IS NOT NULL THEN
    SELECT s.*
    INTO v_session
    FROM public.phone_otp_sessions s
    WHERE s.id = p_otp_session_id
      AND s.salon_id = v_booking.salon_id
      AND public.canonical_phone(s.phone)
          = public.canonical_phone(v_booking.client_phone)
      AND s.expires_at > v_now
      AND (
        s.consumed_at IS NULL
        OR v_booking.otp_session_id = s.id
      )
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'invalid_otp_session'
      );
    END IF;
  END IF;

  UPDATE public.client_profiles cp
  SET
    phone_verified_at = CASE
      WHEN p_otp_session_id IS NULL THEN cp.phone_verified_at
      WHEN cp.phone_verified_at IS NULL
        OR cp.phone_verified_at < v_session.verified_at
        THEN v_session.verified_at
      ELSE cp.phone_verified_at
    END,
    marketing_consent_at = CASE
      WHEN p_marketing_consent THEN v_now
      ELSE cp.marketing_consent_at
    END
  WHERE cp.id = v_booking.client_profile_id;

  IF p_otp_session_id IS NOT NULL THEN
    UPDATE public.bookings
    SET
      verification_method = 'otp',
      verification_completed_at =
        coalesce(verification_completed_at, v_session.verified_at),
      otp_session_id = v_session.id
    WHERE id = v_booking.id;

    UPDATE public.phone_otp_sessions
    SET consumed_at = coalesce(consumed_at, v_now)
    WHERE id = v_session.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'otp_stamped', p_otp_session_id IS NOT NULL,
    'marketing_consent_stamped', p_marketing_consent
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_public_booking_profile(
  uuid, uuid, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_public_booking_profile(
  uuid, uuid, boolean
) TO anon, service_role;

COMMENT ON FUNCTION public.finalize_public_booking_profile(
  uuid, uuid, boolean
) IS
  'Recent-booking capability boundary for atomic OTP consumption and customer profile evidence.';

DO $proof$
DECLARE
  v_oid oid := to_regprocedure(
    'public.finalize_public_booking_profile(uuid,uuid,boolean)'
  );
  v_def text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'finalize_public_booking_profile is missing';
  END IF;

  SELECT pg_get_functiondef(v_oid) INTO v_def;

  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
    OR position('SET search_path TO ''public''' IN v_def) = 0
    OR position('b.created_at >= v_now - interval ''10 minutes''' IN v_def) = 0
    OR position('s.salon_id = v_booking.salon_id' IN v_def) = 0
    OR position('public.canonical_phone(s.phone)' IN v_def) = 0
    OR position('s.consumed_at IS NULL' IN v_def) = 0
    OR position('v_booking.otp_session_id = s.id' IN v_def) = 0
    OR position('cp.id = v_booking.client_profile_id' IN v_def) = 0
    OR NOT has_function_privilege('anon', v_oid, 'EXECUTE')
    OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
    OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'finalize_public_booking_profile boundary mismatch';
  END IF;
END
$proof$;
