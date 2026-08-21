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

  IF v_actual_count <> 10 THEN
    RAISE EXCEPTION
      'anonymous SECURITY DEFINER allowlist drift: expected 10, found %',
      v_actual_count;
  END IF;

  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        (
          'public.add_booking_addons(uuid,uuid[])',
          'v',
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
          'RETURNS jsonb',
          ARRAY[
            'p_status IS DISTINCT FROM ''confirmed''',
            'public.resolve_public_booking_pricing',
            '''pricing_changed''',
            'public_booking_request_fingerprint',
            'p_expected_pricing_fingerprint'
          ]::text[]
        ),
        (
          'public.create_public_waitlist_entry(uuid,uuid,uuid,date,text,text,text,text,text)',
          'v',
          'RETURNS TABLE(id uuid)',
          ARRAY[
            'invalid_waitlist_source',
            'invalid_service_for_salon',
            'invalid_staff_for_salon'
          ]::text[]
        ),
        (
          'public.finalize_public_booking_profile(uuid,uuid,boolean)',
          'v',
          'RETURNS jsonb',
          ARRAY[
            'b.created_at >= v_now - interval ''10 minutes''',
            's.salon_id = v_booking.salon_id',
            'public.canonical_phone(s.phone)',
            's.consumed_at IS NULL',
            'v_booking.otp_session_id = s.id',
            'cp.id = v_booking.client_profile_id'
          ]::text[]
        ),
        (
          'public.get_booking_client_snapshot(uuid,text,uuid)',
          's',
          'RETURNS TABLE(visit_count integer, name text, no_show_count integer, is_vip boolean)',
          ARRAY[
            'b.id = p_booking_id',
            'b.salon_id = p_salon_id',
            'b.created_at >= now() - interval ''10 minutes''',
            'canonical_phone(p_phone)'
          ]::text[]
        ),
        (
          'public.public_booking_occupancy_for_range(uuid,timestamp with time zone,timestamp with time zone)',
          's',
          'RETURNS TABLE(staff_id uuid, start_time_utc timestamp with time zone, end_time_utc timestamp with time zone)',
          ARRAY[
            'select b.staff_id, b.start_time_utc, b.end_time_utc',
            'b.salon_id = p_salon_id'
          ]::text[]
        ),
        (
          'public.public_resolve_domain(text)',
          's',
          'RETURNS text',
          ARRAY[
            'SELECT s.slug',
            'd.domain = lower(p_host)'
          ]::text[]
        ),
        (
          'public.validate_phone_otp_session(uuid,uuid,text)',
          's',
          'RETURNS boolean',
          ARRAY[
            's.id = p_session_id',
            's.salon_id = p_salon_id',
            's.consumed_at IS NULL',
            's.expires_at > now()'
          ]::text[]
        )
    ) AS expected(signature, volatility, result_fragment, guard_fragments)
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
         WHERE setting LIKE 'search_path=public%'
            OR (
              v_target.signature LIKE 'public.create_public_booking(%'
              AND setting = 'search_path=""'
            )
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
      WHERE position(lower(fragment) IN lower(v_definition)) = 0
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
