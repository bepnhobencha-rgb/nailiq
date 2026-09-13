\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_oid oid := to_regprocedure(
    'public.finalize_public_booking_profile(uuid,uuid,boolean)'
  );
  v_def text;
  v_required text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'finalize_public_booking_profile is missing';
  END IF;

  -- Check the current R09 authority contract. The finalizer intentionally uses
  -- an empty search path and a locked v_session / validated v_profile_id;
  -- whitespace and historical aliases are not authorization boundaries.
  SELECT regexp_replace(pg_get_functiondef(v_oid), '[[:space:]]', '', 'g')
    INTO v_def;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid = v_oid
      AND p.prosecdef AND p.provolatile = 'v'
      AND p.prorettype = 'jsonb'::regtype
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
  )
  THEN
    RAISE EXCEPTION 'finalize_public_booking_profile definition boundary mismatch';
  END IF;

  IF NOT has_function_privilege('anon', v_oid, 'EXECUTE')
    OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
    OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
    OR EXISTS (
      SELECT 1 FROM pg_proc p,
        LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'finalize_public_booking_profile execute boundary mismatch';
  END IF;

  FOREACH v_required IN ARRAY ARRAY[
    'b.created_at >= v_now - interval ''10 minutes''',
    'b.created_at >= clock_timestamp() - interval ''10 minutes''',
    's.verified_channel = ''sms'' AND s.salon_id = v_booking.salon_id',
    'public.canonical_phone(s.phone) = v_phone',
    'public.lock_booking_crm_phones(ARRAY[v_phone])',
    'SELECT s.* INTO v_session FROM public.phone_otp_sessions s WHERE s.id = p_otp_session_id FOR UPDATE',
    'v_session.salon_id IS DISTINCT FROM v_booking.salon_id',
    'public.canonical_phone(v_session.phone) IS DISTINCT FROM v_phone',
    '(v_session.verified_channel = ''sms'') IS DISTINCT FROM v_phone_owner',
    'v_session.verified_at IS NULL OR NOT isfinite(v_session.verified_at)',
    'v_session.expires_at IS NULL OR NOT isfinite(v_session.expires_at)',
    'v_session.consumed_by_booking_id = v_booking.id AND v_booking.otp_session_id = v_session.id',
    'v_session.consumed_at >= v_session.verified_at AND v_session.consumed_at < v_session.expires_at',
    'v_session.consumed_at <= v_now',
    'v_session.consumed_at IS NULL AND v_session.consumed_by_booking_id IS NULL AND v_session.expires_at > v_now',
    'IF v_phone_owner THEN',
    'cp.id = v_profile_id AND cp.deleted_at IS NULL AND public.canonical_phone(cp.phone) = v_phone',
    'RAISE EXCEPTION ''crm_otp_expired_at_consumption''',
    'IF SQLERRM = ''crm_otp_expired_at_consumption'' THEN'
  ] LOOP
    IF position(regexp_replace(v_required, '[[:space:]]', '', 'g') IN v_def) = 0 THEN
      RAISE EXCEPTION 'finalize_public_booking_profile authority predicate missing: %', v_required;
    END IF;
  END LOOP;
END
$check$;
