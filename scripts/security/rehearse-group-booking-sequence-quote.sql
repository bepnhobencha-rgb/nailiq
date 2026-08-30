\set ON_ERROR_STOP on

BEGIN;
\ir ../../supabase/migrations/20260829231142_add_atomic_group_booking_sequences.sql
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

DO $group_sequence_quote_rehearsal$
DECLARE
  v_salon uuid := '71000000-0000-4000-8000-000000000001';
  v_service_one uuid := '72000000-0000-4000-8000-000000000001';
  v_service_two uuid := '72000000-0000-4000-8000-000000000002';
  v_staff_one uuid := '73000000-0000-4000-8000-000000000001';
  v_staff_two uuid := '73000000-0000-4000-8000-000000000002';
  v_resource_one uuid := '74000000-0000-4000-8000-000000000001';
  v_resource_two uuid := '74000000-0000-4000-8000-000000000002';
  v_start timestamptz := date_trunc('day', transaction_timestamp() + interval '8 days')
    + interval '12 hours';
  v_readiness jsonb;
  v_request jsonb;
  v_quote jsonb;
  v_changed jsonb;
  v_before_bookings bigint;
  v_before_profiles bigint;
  v_before_otp bigint;
BEGIN
  INSERT INTO public.salons(
    id, slug, name, phone, timezone, opening_hours, currency_code,
    subscription_plan, subscription_status, is_beta, resources_enabled,
    tax_lines, feature_flags
  ) VALUES (
    v_salon, 'disposable-group-sequence-qa', 'Disposable Group Sequence QA',
    '+16045550710', 'UTC',
    '{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}'::jsonb,
    'CAD', 'premium', 'active', true, true,
    '[{"name":"GST","rate":0.05,"enabled":true}]'::jsonb,
    '{"group_booking_enabled":true,"group_multi_service_booking_enabled":true}'::jsonb
  );
  INSERT INTO public.service_categories(slug, name_en, name_vi, sort_order)
  VALUES ('qa-group-sequence', 'QA Group Sequence', 'QA Group Sequence', 999);
  INSERT INTO public.services(
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    prep_minutes, is_addon, addon_timing, category
  ) VALUES
    (v_service_one, v_salon, 'Group Sequence One', 1000, 30, 0, 0,
      false, 'sequential', 'qa-group-sequence'),
    (v_service_two, v_salon, 'Group Sequence Two', 1500, 20, 0, 0,
      false, 'sequential', 'qa-group-sequence');
  INSERT INTO public.staff(id, salon_id, name, status) VALUES
    (v_staff_one, v_salon, 'Group Staff One', 'active'),
    (v_staff_two, v_salon, 'Group Staff Two', 'active');
  INSERT INTO public.salon_resources(
    id, salon_id, name, kind, status, adjacency_group
  ) VALUES
    (v_resource_one, v_salon, 'Pair Room One', 'room', 'active', 'pair-a'),
    (v_resource_two, v_salon, 'Pair Room Two', 'room', 'active', 'pair-a');

  INSERT INTO public.platform_flags(key, enabled, description)
  VALUES ('feature_multi_service_booking', true, 'local group sequence rehearsal')
  ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled;

  v_readiness := public.load_public_group_sequence_readiness(v_salon);
  IF coalesce((v_readiness->>'success')::boolean, false) IS NOT TRUE
     OR coalesce((v_readiness->>'platform_enabled')::boolean, true) IS TRUE
     OR coalesce((v_readiness->>'quote_ready')::boolean, true) IS TRUE
     OR coalesce((v_readiness->>'atomic_commit_ready')::boolean, true) IS TRUE
     OR coalesce((v_readiness->>'ready')::boolean, true) IS TRUE THEN
    RAISE EXCEPTION 'default-off readiness failed: %', v_readiness;
  END IF;

  v_readiness := public.configure_multi_service_booking_qa_salon(
    v_salon, true, 'ENABLE_MULTI_SERVICE_QA'
  );
  IF v_readiness->>'code' <> 'enabled' THEN
    RAISE EXCEPTION 'sequence QA setup failed: %', v_readiness;
  END IF;
  UPDATE public.platform_flags
  SET enabled = true
  WHERE key = 'feature_group_multi_service_booking';

  v_readiness := public.load_public_group_sequence_readiness(v_salon);
  IF coalesce((v_readiness->>'quote_ready')::boolean, false) IS NOT TRUE
     OR coalesce((v_readiness->>'atomic_commit_ready')::boolean, true) IS TRUE
     OR coalesce((v_readiness->>'ready')::boolean, true) IS TRUE
     OR coalesce((v_readiness->>'resource_topology_supported')::boolean, false)
        IS NOT TRUE THEN
    RAISE EXCEPTION 'quote-only readiness failed: %', v_readiness;
  END IF;

  v_request := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'salon_id', v_salon,
    'group_request_id', '75000000-0000-4000-8000-000000000001'::uuid,
    'requested_anchor_utc', v_start,
    'seat_together', true,
    'apply_email_discount', true,
    'organizer', pg_catalog.jsonb_build_object(
      'name', 'Organizer QA', 'phone', '16045550199',
      'email', 'organizer@example.test'
    ),
    'members', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'member_index', 0,
        'member_request_id', '76000000-0000-4000-8000-000000000001'::uuid,
        'requested_start_time_utc', v_start,
        'same_staff_for_all', true,
        'customer', pg_catalog.jsonb_build_object(
          'name', 'Organizer QA', 'phone', '16045550199',
          'email', 'organizer@example.test'
        ),
        'lines', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'line_id', '77000000-0000-4000-8000-000000000001'::uuid,
            'position', 0, 'service_id', v_service_one,
            'staff_preference', v_staff_one::text,
            'preferred_resource_id', v_resource_one,
            'addon_service_ids', '[]'::jsonb
          ),
          pg_catalog.jsonb_build_object(
            'line_id', '77000000-0000-4000-8000-000000000002'::uuid,
            'position', 1, 'service_id', v_service_two,
            'staff_preference', v_staff_one::text,
            'preferred_resource_id', v_resource_one,
            'addon_service_ids', '[]'::jsonb
          )
        )
      ),
      pg_catalog.jsonb_build_object(
        'member_index', 1,
        'member_request_id', '76000000-0000-4000-8000-000000000002'::uuid,
        'requested_start_time_utc', v_start,
        'same_staff_for_all', false,
        'customer', pg_catalog.jsonb_build_object(
          'name', 'Guest QA', 'phone', '', 'email', NULL
        ),
        'lines', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'line_id', '77000000-0000-4000-8000-000000000003'::uuid,
            'position', 0, 'service_id', v_service_two,
            'staff_preference', v_staff_two::text,
            'preferred_resource_id', v_resource_two,
            'addon_service_ids', '[]'::jsonb
          )
        )
      )
    )
  );

  SELECT count(*) INTO v_before_bookings FROM public.bookings;
  SELECT count(*) INTO v_before_profiles FROM public.client_profiles;
  SELECT count(*) INTO v_before_otp FROM public.phone_otp_sessions;
  v_quote := public.quote_public_group_booking_sequences(v_request);
  IF coalesce((v_quote->>'success')::boolean, false) IS NOT TRUE
     OR v_quote->>'code' <> 'quoted'
     OR (v_quote->>'member_count')::integer <> 2
     OR (v_quote->>'service_line_count')::integer <> 3
     OR pg_catalog.jsonb_array_length(v_quote->'member_quotes') <> 2
     OR length(v_quote->>'pricing_fingerprint') <> 64
     OR (v_quote->>'total_cents')::integer <= 0 THEN
    RAISE EXCEPTION 'whole-party quote failed: %', v_quote;
  END IF;
  IF (SELECT count(*) FROM public.bookings) <> v_before_bookings
     OR (SELECT count(*) FROM public.client_profiles) <> v_before_profiles
     OR (SELECT count(*) FROM public.phone_otp_sessions) <> v_before_otp THEN
    RAISE EXCEPTION 'quote-only resolver produced a business write';
  END IF;

  v_changed := public.quote_public_group_booking_sequences(
    pg_catalog.jsonb_set(
      v_request,
      '{members,1,lines,0,staff_preference}',
      pg_catalog.to_jsonb(v_staff_one::text)
    )
  );
  IF v_changed->>'code' <> 'group_slot_conflict' THEN
    RAISE EXCEPTION 'cross-member staff conflict escaped: %', v_changed;
  END IF;

  UPDATE public.salon_resources
  SET adjacency_group = 'pair-b'
  WHERE id = v_resource_two;
  v_changed := public.quote_public_group_booking_sequences(v_request);
  IF v_changed->>'code' <> 'seat_together_unproven' THEN
    RAISE EXCEPTION 'unproven resource topology escaped: %', v_changed;
  END IF;
END;
$group_sequence_quote_rehearsal$;

ROLLBACK;
