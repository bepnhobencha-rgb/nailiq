\set ON_ERROR_STOP on

-- These are the only SECURITY DEFINER functions that anonymous booking traffic
-- may execute. They are intentionally narrow RPC boundaries over RLS-protected
-- tables; converting them to SECURITY INVOKER would either break the public
-- flow or require exposing the underlying customer/booking tables directly.
DO $check$
DECLARE
  v_target record;
  v_oid oid;
  v_definition text;
  v_public_execute boolean;
  v_actual_count integer;
BEGIN
  SELECT count(*)
    INTO v_actual_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_actual_count <> 13 THEN
    RAISE EXCEPTION
      'anonymous SECURITY DEFINER allowlist drift: expected 13, found %',
      v_actual_count;
  END IF;

  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        (
          'public.add_booking_addons(uuid,uuid[])',
          'v',
          'search_path=public, pg_catalog',
          'RETURNS integer',
          ARRAY[
            'cardinality(p_service_ids) > 8',
            'v_created_at < now() - interval ''15 minutes''',
            's.salon_id = v_salon_id'
          ]::text[]
        ),
        (
          'public.check_group_slots_available(jsonb)',
          's',
          'search_path=public',
          'RETURNS jsonb',
          ARRAY[
            'jsonb_build_object(''available'', true)',
            '''conflicting_members''',
            'b.deleted_at IS NULL'
          ]::text[]
        ),
        (
          'public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,integer,text,uuid,integer,text,uuid)',
          'v',
          'search_path=""',
          'RETURNS jsonb',
          ARRAY[
            'v_role = ''anon''',
            'public.resolve_public_booking_pricing',
            '''public-booking-client:''',
            '''public-booking:salon:''',
            '''public-booking:phone:'''
          ]::text[]
        ),
        (
          'public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text)',
          'v',
          'search_path=""',
          'RETURNS jsonb',
          ARRAY[
            'public.create_public_booking',
            'p_expected_pricing_fingerprint, NULL::uuid'
          ]::text[]
        ),
        (
          'public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid)',
          'v',
          'search_path=""',
          'RETURNS jsonb',
          ARRAY[
            'p_status IS DISTINCT FROM ''confirmed''',
            'public.resolve_public_booking_pricing',
            '''pricing_changed''',
            'public_booking_request_fingerprint',
            'p_expected_pricing_fingerprint',
            'public.booking_incentive_phone_ownership',
            '''phone_verification_required''',
            'clock_timestamp()',
            'consumed_by_booking_id'
          ]::text[]
        ),
        (
          'public.finalize_public_booking_profile(uuid,uuid,boolean)',
          'v',
          'search_path=""',
          'RETURNS jsonb',
          ARRAY[
            'b.created_at >= v_now - interval ''10 minutes''',
            's.salon_id = v_booking.salon_id',
            'public.canonical_phone(s.phone)',
            'v_session.consumed_at IS NULL',
            'v_booking.otp_session_id=v_session.id',
            's.verified_channel=''sms''',
            '(v_session.verified_channel=''sms'') IS DISTINCT FROM v_phone_owner',
            'public.lock_booking_crm_phones',
            'IF v_phone_owner THEN',
            'cp.id=v_profile_id',
            'public.canonical_phone(cp.phone)=v_phone',
            'crm_otp_expired_at_consumption',
            'v_session.consumed_at<v_session.expires_at'
          ]::text[]
        ),
        (
          'public.get_booking_client_snapshot(uuid,text,uuid)',
          's',
          'search_path=""',
          'RETURNS TABLE(visit_count integer, name text, no_show_count integer, is_vip boolean)',
          ARRAY[
            'b.id = p_booking_id',
            'b.salon_id = p_salon_id',
            'b.created_at >= now() - interval ''10 minutes''',
            'canonical_phone(p_phone)',
            's.id = b.otp_session_id',
            's.verified_channel = ''sms''',
            's.salon_id = b.salon_id',
            'public.canonical_phone(s.phone) = public.canonical_phone(b.client_phone)',
            's.consumed_by_booking_id = b.id',
            's.consumed_at IS NOT NULL',
            'pg_catalog.isfinite(s.consumed_at)',
            'pg_catalog.isfinite(s.verified_at)',
            'pg_catalog.isfinite(s.expires_at)',
            's.consumed_at >= s.verified_at',
            's.consumed_at < s.expires_at',
            's.consumed_at <= clock_timestamp()',
            'public.canonical_phone(cp.phone) = public.canonical_phone(b.client_phone)'
          ]::text[]
        ),
        (
          'public.public_booking_capacity_for_range(uuid,timestamp with time zone,timestamp with time zone)',
          's',
          'search_path=""',
          'RETURNS TABLE(staff_id uuid, resource_id uuid, start_time_utc timestamp with time zone, end_time_utc timestamp with time zone)',
          ARRAY[
            'SELECT b.staff_id, b.resource_id',
            'b.salon_id = p_salon_id',
            'b.status NOT IN (''cancelled'', ''waiting'', ''no_show'', ''completed'')',
            'seg.salon_id = p_salon_id',
            'seg.reservation_status NOT IN (''cancelled'', ''no_show'', ''completed'')'
          ]::text[]
        ),
        (
          'public.public_booking_occupancy_for_range(uuid,timestamp with time zone,timestamp with time zone)',
          's',
          'search_path=public',
          'RETURNS TABLE(staff_id uuid, start_time_utc timestamp with time zone, end_time_utc timestamp with time zone)',
          ARRAY[
            'select b.staff_id, b.start_time_utc, b.end_time_utc',
            'b.salon_id = p_salon_id'
          ]::text[]
        ),
        (
          'public.public_resolve_domain(text)',
          's',
          'search_path=public',
          'RETURNS text',
          ARRAY[
            'SELECT s.slug',
            'd.domain = lower(p_host)'
          ]::text[]
        ),
        (
          'public.public_salon_accepts_new_bookings(uuid)',
          's',
          'search_path=""',
          'RETURNS boolean',
          ARRAY[
            's.profile_complete IS TRUE',
            'public.tenant_trial_entitlement_state',
            'IN (''legacy'', ''active_trial'', ''active'', ''past_due'')',
            'WHERE s.id = p_salon_id'
          ]::text[]
        ),
        (
          'public.validate_booking_otp_session(uuid,uuid,text)',
          's',
          'search_path=""',
          'RETURNS boolean',
          ARRAY[
            's.id = p_session_id',
            's.salon_id = p_salon_id',
            's.phone = pg_catalog.regexp_replace',
            's.verified_channel IN (''sms'', ''email'', ''staff_attested'', ''demo'')',
            's.consumed_at IS NULL',
            's.consumed_by_booking_id IS NULL',
            's.expires_at > now()'
          ]::text[]
        ),
        (
          'public.validate_phone_otp_session(uuid,uuid,text)',
          's',
          'search_path=""',
          'RETURNS boolean',
          ARRAY[
            's.id = p_session_id',
            's.salon_id = p_salon_id',
            's.phone = pg_catalog.regexp_replace',
            's.verified_channel = ''sms''',
            's.consumed_at IS NULL',
            's.consumed_by_booking_id IS NULL',
            's.expires_at > now()'
          ]::text[]
        )
    ) AS expected(signature, volatility, search_path_setting, result_fragment, guard_fragments)
  LOOP
    v_oid := to_regprocedure(v_target.signature)::oid;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'intentional anonymous definer is missing: %',
        v_target.signature;
    END IF;

    SELECT pg_get_functiondef(v_oid) INTO v_definition;

    SELECT EXISTS (
      SELECT 1
      FROM aclexplode(
        COALESCE(
          (SELECT proacl FROM pg_proc WHERE oid = v_oid),
          acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
        )
      )
      WHERE grantee = 0
        AND privilege_type = 'EXECUTE'
    ) INTO v_public_execute;

    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
       OR (SELECT provolatile FROM pg_proc WHERE oid = v_oid)
            <> v_target.volatility::"char"
       OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = v_oid)
            <> 'postgres'
       OR NOT EXISTS (
         SELECT 1
         FROM unnest((SELECT proconfig FROM pg_proc WHERE oid = v_oid)) setting
         WHERE setting = v_target.search_path_setting
       )
       OR v_public_execute
       OR NOT has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'security or role boundary mismatch on %', v_target.signature;
    END IF;

    IF position(lower(v_target.result_fragment) IN lower(v_definition)) = 0 THEN
      RAISE EXCEPTION 'return contract drift on %', v_target.signature;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM unnest(v_target.guard_fragments) fragment
      WHERE position(regexp_replace(lower(fragment), '\s+', '', 'g')
        IN regexp_replace(lower(v_definition), '\s+', '', 'g')) = 0
    ) THEN
      RAISE EXCEPTION 'required public-input guard drift on %',
        v_target.signature;
    END IF;
  END LOOP;

  -- Direct anonymous access remains closed where the RPC exists specifically
  -- to publish a sanitized projection or controlled write.
  IF has_table_privilege('anon', 'public.bookings', 'INSERT')
     OR has_table_privilege('anon', 'public.client_profiles', 'SELECT')
     OR has_table_privilege('anon', 'public.phone_otp_sessions', 'SELECT')
     OR has_table_privilege('anon', 'public.salons', 'SELECT') THEN
    RAISE EXCEPTION
      'an underlying protected table is directly exposed to anon';
  END IF;

  IF NOT (
    SELECT bool_and(c.relrowsecurity)
    FROM unnest(ARRAY[
      'booking_addons',
      'booking_waitlist_entries',
      'bookings',
      'client_profiles',
      'phone_otp_sessions',
      'salon_custom_domains'
    ]) target(table_name)
    JOIN pg_class c ON c.relname = target.table_name
    JOIN pg_namespace n ON n.oid = c.relnamespace
      AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'an underlying RPC table no longer has RLS enabled';
  END IF;
END
$check$;
