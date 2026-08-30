\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

CREATE FUNCTION public.qa_fail_group_sequence_organizer_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $qa_fail_group_sequence_organizer_insert$
BEGIN
  IF NEW.salon_id = '81000000-0000-4000-8000-000000000001'::uuid
     AND NEW.is_group_organizer IS TRUE
     AND NEW.client_name = 'Organizer Rollback' THEN
    RAISE check_violation
      USING MESSAGE = 'synthetic organizer insert failure';
  END IF;
  RETURN NEW;
END;
$qa_fail_group_sequence_organizer_insert$;

CREATE TRIGGER qa_fail_group_sequence_organizer_insert
BEFORE INSERT ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.qa_fail_group_sequence_organizer_insert();

DO $group_sequence_commit_rehearsal$
DECLARE
  v_salon uuid := '81000000-0000-4000-8000-000000000001';
  v_service_one uuid := '82000000-0000-4000-8000-000000000001';
  v_service_two uuid := '82000000-0000-4000-8000-000000000002';
  v_staff_one uuid := '83000000-0000-4000-8000-000000000001';
  v_staff_two uuid := '83000000-0000-4000-8000-000000000002';
  v_resource_one uuid := '84000000-0000-4000-8000-000000000001';
  v_resource_two uuid := '84000000-0000-4000-8000-000000000002';
  v_otp_one uuid := '85000000-0000-4000-8000-000000000001';
  v_otp_two uuid := '85000000-0000-4000-8000-000000000002';
  v_group_request uuid := '86000000-0000-4000-8000-000000000001';
  v_member_one uuid := '87000000-0000-4000-8000-000000000001';
  v_member_two uuid := '87000000-0000-4000-8000-000000000002';
  v_start timestamptz := date_trunc(
    'day', transaction_timestamp() + interval '12 days'
  ) + interval '12 hours';
  v_second_start timestamptz := date_trunc(
    'day', transaction_timestamp() + interval '14 days'
  ) + interval '12 hours';
  v_request jsonb;
  v_quote jsonb;
  v_create_request jsonb;
  v_created jsonb;
  v_replayed jsonb;
  v_changed jsonb;
  v_conflict_request jsonb;
  v_conflict_quote jsonb;
  v_conflict_create jsonb;
  v_readiness jsonb;
  v_organizer_booking uuid;
  v_group_id uuid;
  v_before bigint;
BEGIN
  INSERT INTO public.salons(
    id, slug, name, phone, timezone, opening_hours, currency_code,
    subscription_plan, subscription_status, is_beta, resources_enabled,
    phone_otp_enabled, tax_lines, feature_flags
  ) VALUES (
    v_salon, 'disposable-group-sequence-commit',
    'Disposable Group Sequence Commit', '+16045550810', 'UTC',
    '{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}'::jsonb,
    'CAD', 'premium', 'active', true, true, true,
    '[{"name":"GST","rate":0.05,"enabled":true}]'::jsonb,
    '{"group_booking_enabled":true,"group_multi_service_booking_enabled":true}'::jsonb
  );
  INSERT INTO public.service_categories(slug, name_en, name_vi, sort_order)
  VALUES (
    'qa-group-sequence-commit',
    'QA Group Sequence Commit',
    'QA Group Sequence Commit',
    998
  );
  INSERT INTO public.services(
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    prep_minutes, is_addon, addon_timing, category
  ) VALUES
    (v_service_one, v_salon, 'Commit One', 1000, 30, 0, 0,
      false, 'sequential', 'qa-group-sequence-commit'),
    (v_service_two, v_salon, 'Commit Two', 1500, 20, 0, 0,
      false, 'sequential', 'qa-group-sequence-commit');
  INSERT INTO public.staff(id, salon_id, name, status) VALUES
    (v_staff_one, v_salon, 'Commit Staff One', 'active'),
    (v_staff_two, v_salon, 'Commit Staff Two', 'active');
  INSERT INTO public.salon_resources(
    id, salon_id, name, kind, status, adjacency_group
  ) VALUES
    (v_resource_one, v_salon, 'Commit Room One', 'room', 'active', 'pair-c'),
    (v_resource_two, v_salon, 'Commit Room Two', 'room', 'active', 'pair-c');
  INSERT INTO public.platform_flags(key, enabled, description)
  VALUES
    ('feature_multi_service_booking', true, 'local group commit rehearsal'),
    ('feature_group_multi_service_booking', true, 'local group commit rehearsal')
  ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled;

  v_readiness := public.configure_multi_service_booking_qa_salon(
    v_salon, true, 'ENABLE_MULTI_SERVICE_QA'
  );
  IF v_readiness->>'code' <> 'enabled' THEN
    RAISE EXCEPTION 'sequence QA setup failed: %', v_readiness;
  END IF;
  v_readiness := public.load_public_group_sequence_readiness(v_salon);
  IF coalesce((v_readiness->>'quote_ready')::boolean, false) IS NOT TRUE
     OR coalesce((v_readiness->>'atomic_commit_ready')::boolean, false)
        IS NOT TRUE
     OR coalesce((v_readiness->>'management_lifecycle_ready')::boolean, true)
        IS TRUE
     OR coalesce((v_readiness->>'ready')::boolean, true) IS TRUE THEN
    RAISE EXCEPTION 'Phase 2B1 readiness boundary failed: %', v_readiness;
  END IF;

  INSERT INTO public.phone_otp_sessions(
    id, salon_id, phone, verified_at, expires_at
  ) VALUES (
    v_otp_one, v_salon, '16045550199', transaction_timestamp(),
    transaction_timestamp() + interval '30 minutes'
  );

  v_request := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'salon_id', v_salon,
    'group_request_id', v_group_request,
    'requested_anchor_utc', v_start,
    'seat_together', true,
    'apply_email_discount', true,
    'organizer', pg_catalog.jsonb_build_object(
      'name', 'Organizer Commit',
      'phone', '16045550199',
      'email', 'organizer-commit@example.test'
    ),
    'members', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'member_index', 0,
        'member_request_id', v_member_one,
        'requested_start_time_utc', v_start,
        'same_staff_for_all', true,
        'customer', pg_catalog.jsonb_build_object(
          'name', 'Organizer Commit',
          'phone', '16045550199',
          'email', 'organizer-commit@example.test'
        ),
        'lines', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'line_id', '88000000-0000-4000-8000-000000000001'::uuid,
            'position', 0,
            'service_id', v_service_one,
            'staff_preference', v_staff_one::text,
            'preferred_resource_id', v_resource_one,
            'addon_service_ids', '[]'::jsonb
          ),
          pg_catalog.jsonb_build_object(
            'line_id', '88000000-0000-4000-8000-000000000002'::uuid,
            'position', 1,
            'service_id', v_service_two,
            'staff_preference', v_staff_one::text,
            'preferred_resource_id', v_resource_one,
            'addon_service_ids', '[]'::jsonb
          )
        )
      ),
      pg_catalog.jsonb_build_object(
        'member_index', 1,
        'member_request_id', v_member_two,
        'requested_start_time_utc', v_start,
        'same_staff_for_all', false,
        'customer', pg_catalog.jsonb_build_object(
          'name', 'Guest Commit', 'phone', '', 'email', NULL
        ),
        'lines', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'line_id', '88000000-0000-4000-8000-000000000003'::uuid,
            'position', 0,
            'service_id', v_service_two,
            'staff_preference', v_staff_two::text,
            'preferred_resource_id', v_resource_two,
            'addon_service_ids', '[]'::jsonb
          )
        )
      )
    )
  );

  v_quote := public.quote_public_group_booking_sequences(v_request);
  IF v_quote->>'code' <> 'quoted' THEN
    RAISE EXCEPTION 'whole-party quote failed: %', v_quote;
  END IF;
  v_create_request := v_request || pg_catalog.jsonb_build_object(
    'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint',
    'otp_session_id', v_otp_one,
    'health_acknowledged', false,
    'sms_consent', true,
    'notification_language', 'en'
  );
  v_created := public.create_public_group_booking_sequences(v_create_request);
  IF v_created->>'code' <> 'booked'
     OR coalesce((v_created->>'idempotent')::boolean, true) IS TRUE
     OR pg_catalog.jsonb_array_length(v_created->'booking_ids') <> 2
     OR pg_catalog.jsonb_array_length(v_created->'member_receipts') <> 2 THEN
    RAISE EXCEPTION 'whole-party atomic create failed: %', v_created;
  END IF;
  v_organizer_booking := (v_created->>'organizer_booking_id')::uuid;
  v_group_id := (v_created->>'group_id')::uuid;
  IF (SELECT count(*) FROM public.bookings b
      WHERE b.salon_id = v_salon AND b.group_id = v_group_id) <> 2
     OR (SELECT count(*) FROM public.booking_service_segments seg
         WHERE seg.salon_id = v_salon) <> 3
     OR NOT EXISTS (
       SELECT 1 FROM public.phone_otp_sessions otp
       WHERE otp.id = v_otp_one
         AND otp.consumed_at IS NOT NULL
         AND otp.consumed_by_booking_id = v_organizer_booking
     )
     OR EXISTS (
       SELECT 1 FROM public.bookings b
       WHERE b.salon_id = v_salon
         AND b.group_id = v_group_id
         AND b.id <> v_organizer_booking
         AND (b.otp_session_id IS NOT NULL OR b.verification_method IS NOT NULL)
     )
     OR EXISTS (
       SELECT 1 FROM public.bookings b
       WHERE b.salon_id = v_salon
         AND b.group_id = v_group_id
         AND b.id <> v_organizer_booking
         AND b.client_phone IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'organizer-only identity/OTP invariant failed';
  END IF;

  v_replayed := public.create_public_group_booking_sequences(v_create_request);
  IF v_replayed->>'code' <> 'booked'
     OR coalesce((v_replayed->>'idempotent')::boolean, false) IS NOT TRUE
     OR v_replayed->>'group_id' IS DISTINCT FROM v_group_id::text THEN
    RAISE EXCEPTION 'exact create replay failed: %', v_replayed;
  END IF;
  v_replayed := public.replay_public_group_booking_sequences(v_create_request);
  IF v_replayed->>'code' <> 'booked'
     OR coalesce((v_replayed->>'idempotent')::boolean, false) IS NOT TRUE
     OR v_replayed->>'group_id' IS DISTINCT FROM v_group_id::text THEN
    RAISE EXCEPTION 'read-only replay failed: %', v_replayed;
  END IF;
  v_changed := public.create_public_group_booking_sequences(
    pg_catalog.jsonb_set(v_create_request, '{sms_consent}', 'false'::jsonb)
  );
  IF v_changed->>'code' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'changed replay escaped: %', v_changed;
  END IF;

  INSERT INTO public.phone_otp_sessions(
    id, salon_id, phone, verified_at, expires_at
  ) VALUES (
    v_otp_two, v_salon, '16045550199', transaction_timestamp(),
    transaction_timestamp() + interval '30 minutes'
  );
  v_conflict_request := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(
              v_request,
              '{group_request_id}',
              pg_catalog.to_jsonb(
                '86000000-0000-4000-8000-000000000002'::uuid
              )
            ),
            '{requested_anchor_utc}', pg_catalog.to_jsonb(v_second_start)
          ),
          '{members,0,member_request_id}',
          pg_catalog.to_jsonb(
            '87000000-0000-4000-8000-000000000003'::uuid
          )
        ),
        '{members,0,requested_start_time_utc}',
        pg_catalog.to_jsonb(v_second_start)
      ),
      '{members,1,requested_start_time_utc}',
      pg_catalog.to_jsonb(v_second_start)
    ),
    '{members,0,lines,0,line_id}',
    pg_catalog.to_jsonb('88000000-0000-4000-8000-000000000004'::uuid)
  );
  v_conflict_request := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_conflict_request,
      '{members,0,lines,1,line_id}',
      pg_catalog.to_jsonb('88000000-0000-4000-8000-000000000005'::uuid)
    ),
    '{members,1,lines,0,line_id}',
    pg_catalog.to_jsonb('88000000-0000-4000-8000-000000000006'::uuid)
  );
  v_conflict_request := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(
      v_conflict_request,
      '{organizer,name}',
      '"Organizer Rollback"'::jsonb
    ),
    '{members,0,customer,name}',
    '"Organizer Rollback"'::jsonb
  );
  v_conflict_quote := public.quote_public_group_booking_sequences(
    v_conflict_request
  );
  IF v_conflict_quote->>'code' <> 'quoted' THEN
    RAISE EXCEPTION 'rollback rehearsal quote failed: %', v_conflict_quote;
  END IF;
  v_conflict_create := v_conflict_request || pg_catalog.jsonb_build_object(
    'expected_pricing_fingerprint',
      v_conflict_quote->>'pricing_fingerprint',
    'otp_session_id', v_otp_two,
    'health_acknowledged', false,
    'sms_consent', true,
    'notification_language', 'en'
  );
  SELECT count(*) INTO v_before FROM public.bookings
  WHERE salon_id = v_salon;
  v_conflict_create := public.create_public_group_booking_sequences(
    v_conflict_create
  );
  IF v_conflict_create->>'code' <> 'invalid_reference'
     OR (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon)
        <> v_before
     OR EXISTS (
       SELECT 1 FROM public.phone_otp_sessions otp
       WHERE otp.id = v_otp_two AND otp.consumed_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'synthetic all-member rollback failed: %', v_conflict_create;
  END IF;
END;
$group_sequence_commit_rehearsal$;

ROLLBACK;
