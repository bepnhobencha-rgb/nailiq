\set ON_ERROR_STOP on

DO $check$
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
$check$;
