\set ON_ERROR_STOP on

BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);

CREATE FUNCTION pg_temp.fail_second_sequence_reschedule_segment()
RETURNS trigger LANGUAGE plpgsql AS $fail_segment$
BEGIN
  IF current_setting('nailiq.sequence_reschedule_booking_id',true)<>''
     AND NEW.position=1 THEN
    RAISE EXCEPTION 'forced sequence reschedule segment failure';
  END IF;
  RETURN NEW;
END;
$fail_segment$;
CREATE TRIGGER qa_fail_second_sequence_reschedule_segment
  BEFORE UPDATE ON public.booking_service_segments
  FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_second_sequence_reschedule_segment();

DO $sequence_behavior$
DECLARE
  v_salon uuid := '10000000-0000-4000-8000-000000000001';
  v_service_one uuid := '20000000-0000-4000-8000-000000000001';
  v_service_two uuid := '20000000-0000-4000-8000-000000000002';
  v_addon uuid := '20000000-0000-4000-8000-000000000003';
  v_staff_one uuid := '30000000-0000-4000-8000-000000000001';
  v_staff_two uuid := '30000000-0000-4000-8000-000000000002';
  v_resource_one uuid := '35000000-0000-4000-8000-000000000001';
  v_resource_two uuid := '35000000-0000-4000-8000-000000000002';
  v_desk_actor uuid := '36000000-0000-4000-8000-000000000001';
  v_request_id uuid := '40000000-0000-4000-8000-000000000001';
  v_line_one uuid := '50000000-0000-4000-8000-000000000001';
  v_line_two uuid := '50000000-0000-4000-8000-000000000002';
  v_start timestamptz := date_trunc('day', transaction_timestamp() + interval '8 days')
    + interval '12 hours';
  v_request jsonb;
  v_quote jsonb;
  v_created jsonb;
  v_replay jsonb;
  v_readiness jsonb;
  v_receipt jsonb;
  v_cap jsonb;
  v_management jsonb;
  v_single_quote jsonb;
  v_one_line_quote jsonb;
  v_one_line_request jsonb;
  v_booking_id uuid;
  v_segment_ids jsonb;
  v_before_count bigint;
  v_changed jsonb;
  v_otp_session uuid := '60000000-0000-4000-8000-000000000001';
  v_other_otp_session uuid := '60000000-0000-4000-8000-000000000002';
  v_wrong_phone_otp_session uuid := '60000000-0000-4000-8000-000000000003';
  v_other_salon uuid := '10000000-0000-4000-8000-000000000002';
  v_otp_booking_id uuid;
  v_sequence_quote jsonb;
  v_sequence_cap jsonb;
  v_old_snapshot jsonb;
  v_old_parent_start timestamptz;
  v_conflict_booking uuid;
  v_conflict_cap jsonb;
  v_conflict_quote jsonb;
  v_conflict_start timestamptz;
  v_conflict_end timestamptz;
  v_conflict_staff uuid;
  v_conflict_resource uuid;
  v_dst_date date;
  v_dst_start timestamptz;
  v_five_request jsonb;
  v_five_quote jsonb;
  v_five_created jsonb;
  v_five_cap jsonb;
  v_five_booking uuid;
  v_resource_booking_id uuid;
BEGIN
  INSERT INTO public.salons(
    id, slug, name, phone, timezone, opening_hours, currency_code,
    subscription_plan, subscription_status, is_beta, resources_enabled,
    tax_lines, feature_flags, noshow_protection_enabled, payment_provider,
    cancellation_policy
  ) VALUES (
    v_salon, 'disposable-sequence-qa', 'Disposable Sequence QA', '+16045550101',
    'UTC',
    '{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}'::jsonb,
    'CAD', 'premium', 'active', true, false,
    '[{"name":"GST","rate":0.05,"enabled":true}]'::jsonb, '{}'::jsonb,
    true, 'square',
    '{"en":"QA no-show policy with exact fee consent.","vi":"Chính sách vắng mặt QA với phí đồng ý chính xác."}'::jsonb
  );
  INSERT INTO public.square_integrations(
    salon_id, merchant_id, location_id, access_token, application_id,
    environment, enabled, deposit_enabled
  ) VALUES (
    v_salon, 'disposable-sequence-merchant', 'disposable-sequence-location',
    'disposable-sequence-token', 'disposable-sequence-app',
    'sandbox', true, false
  );
  INSERT INTO auth.users(
    id,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at
  ) VALUES(
    v_desk_actor,'sequence-desk@nailiq.invalid','',
    transaction_timestamp(),'{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,transaction_timestamp()
  );
  INSERT INTO public.salon_members(salon_id,user_id,role)
  VALUES(v_salon,v_desk_actor,'receptionist');
  INSERT INTO public.service_categories(slug, name_en, name_vi, sort_order)
  VALUES ('qa-sequence', 'QA Sequence', 'QA Sequence', 999);
  INSERT INTO public.services(
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    prep_minutes, is_addon, addon_timing, category
  ) VALUES
    (v_service_one, v_salon, 'Sequence One', 1001, 30, 0, 5, false, 'sequential', 'qa-sequence'),
    (v_service_two, v_salon, 'Sequence Two', 999, 20, 0, 5, false, 'sequential', 'qa-sequence'),
    (v_addon, v_salon, 'Sequence Add-on', 250, 10, 0, 0, true, 'sequential', 'qa-sequence');
  INSERT INTO public.staff(id, salon_id, name, status) VALUES
    (v_staff_one, v_salon, 'Sequence Staff One', 'active'),
    (v_staff_two, v_salon, 'Sequence Staff Two', 'active');
  INSERT INTO public.promotions(
    salon_id, name, description, starts_at, ends_at,
    discount_type, discount_value, applies_to, active
  ) VALUES (
    v_salon, 'Sequence Promo', 'receipt snapshot proof',
    transaction_timestamp() - interval '1 day',
    transaction_timestamp() + interval '30 days',
    'percent', 10, 'all', true
  );
  INSERT INTO public.vouchers(
    salon_id, code, kind, amount_off_cents, max_uses, valid_from, expires_at
  ) VALUES (
    v_salon, 'SEQ-RECEIPT', 'promo', 100, 1,
    transaction_timestamp() - interval '1 day',
    transaction_timestamp() + interval '30 days'
  );
  INSERT INTO public.vouchers(
    salon_id, code, kind, amount_off_cents, max_uses, valid_from, expires_at
  ) VALUES (
    v_salon, 'SEQ-MATRIX', 'promo', 1, 10,
    transaction_timestamp() - interval '1 day',
    transaction_timestamp() + interval '30 days'
  );

  INSERT INTO public.platform_flags(key, enabled, description)
  VALUES ('feature_multi_service_booking', true, 'transactional QA rehearsal')
  ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled;

  v_readiness := public.configure_multi_service_booking_qa_salon(
    v_salon, true, 'ENABLE_MULTI_SERVICE_QA'
  );
  IF v_readiness->>'code' <> 'enabled'
     OR coalesce((v_readiness#>>'{readiness,ready}')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'QA setter/readiness failed: %', v_readiness;
  END IF;

  -- Both capable staff are occupied exactly when line two would start. The
  -- scheduler must search to the earliest later minute instead of rejecting.
  INSERT INTO public.bookings(
    salon_id, service_id, staff_id, client_name, client_phone,
    start_time_utc, end_time_utc, status, source, schedule_model
  ) VALUES
    (v_salon, v_service_one, v_staff_one, 'Existing One', '16045550111',
      v_start + interval '40 minutes', v_start + interval '50 minutes',
      'confirmed', 'appointment', 'single'),
    (v_salon, v_service_one, v_staff_two, 'Existing Two', '16045550112',
      v_start + interval '40 minutes', v_start + interval '50 minutes',
      'confirmed', 'appointment', 'single');

  v_request := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'salon_id', v_salon,
    'request_id', v_request_id,
    'requested_start_time_utc', v_start,
    'lines', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'line_id', v_line_one, 'position', 0, 'service_id', v_service_one,
        'staff_preference', 'any', 'preferred_resource_id', NULL,
        'addon_service_ids', pg_catalog.jsonb_build_array(v_addon)
      ),
      pg_catalog.jsonb_build_object(
        'line_id', v_line_two, 'position', 1, 'service_id', v_service_two,
        'staff_preference', 'any', 'preferred_resource_id', NULL,
        'addon_service_ids', '[]'::jsonb
      )
    ),
    'same_staff_for_all', false,
    'voucher_code', 'SEQ-RECEIPT',
    'apply_email_discount', true,
    'customer', pg_catalog.jsonb_build_object(
      'name', 'Sequence Customer', 'phone', '+1 (604) 555-0199',
      'email', 'sequence@example.test'
    )
  );

  v_quote := public.quote_public_booking_sequence(v_request);
  IF coalesce((v_quote->>'success')::boolean, false) IS NOT TRUE
     OR v_quote->>'code' <> 'quoted'
     OR pg_catalog.jsonb_array_length(v_quote->'segments') <> 2
     OR pg_catalog.jsonb_array_length(v_quote->'timing_segments') <> 2
     OR (v_quote#>>'{segments,0,email_discount_cents}')::integer <> 200
     OR (v_quote#>>'{segments,1,email_discount_cents}')::integer <> 0
     OR (v_quote#>>'{segments,1,service_start_utc}')::timestamptz
        < v_start + interval '55 minutes' THEN
    RAISE EXCEPTION 'authoritative sequence quote failed: %', v_quote;
  END IF;
  IF (v_quote->>'total_cents')::integer < 0
     OR (SELECT sum((line->>'total_cents')::integer)
         FROM pg_catalog.jsonb_array_elements(v_quote->'segments') line)
        <> (v_quote->>'total_cents')::integer THEN
    RAISE EXCEPTION 'aggregate/line price mismatch: %', v_quote;
  END IF;

  v_created := public.create_public_booking_sequence(
    v_request || pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint',
      'sms_consent',true,'notification_language','en'
    )
  );
  IF coalesce((v_created->>'success')::boolean, false) IS NOT TRUE
     OR v_created->>'code' <> 'booked'
     OR v_created->>'salon_slug'<>'disposable-sequence-qa'
     OR coalesce((v_created->>'idempotent')::boolean, true) IS TRUE THEN
    RAISE EXCEPTION 'sequence create failed: %', v_created;
  END IF;
  v_booking_id := (v_created->>'booking_id')::uuid;
  v_segment_ids := v_created->'segment_ids';
  IF (SELECT count(*) FROM public.booking_service_segments seg
      WHERE seg.booking_id = v_booking_id) <> 2
     OR (SELECT count(*) FROM public.booking_addons ba
         WHERE ba.booking_id = v_booking_id
           AND ba.booking_service_segment_id IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'sequence rows/add-ons not persisted atomically';
  END IF;

  v_replay := public.create_public_booking_sequence(
    v_request || pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint',
      'sms_consent',true,'notification_language','en'
    )
  );
  IF coalesce((v_replay->>'idempotent')::boolean, false) IS NOT TRUE
     OR v_replay->>'booking_id' <> v_booking_id::text
     OR v_replay->'segment_ids' IS DISTINCT FROM v_segment_ids THEN
    RAISE EXCEPTION 'exact replay drifted: %', v_replay;
  END IF;

  v_changed := public.create_public_booking_sequence(
    pg_catalog.jsonb_set(
      v_request || pg_catalog.jsonb_build_object(
        'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint',
        'sms_consent',true,'notification_language','en'
      ), '{customer,name}', '"Changed Customer"'::jsonb
    )
  );
  IF v_changed->>'code' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'changed replay was accepted: %', v_changed;
  END IF;

  -- Public create replay-only marker. Recovery happens before current
  -- readiness/rate/OTP/catalog state, returns the stored consent/language, and
  -- rejects either changed side-effect material without any notification row.
  SELECT count(*) INTO v_before_count FROM public.booking_notifications n
  WHERE n.booking_id=v_booking_id;
  v_replay:=public.replay_public_booking_sequence(
    v_request||pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint',v_quote->>'pricing_fingerprint',
      'sms_consent',true,'notification_language','en'));
  IF v_replay->>'code'<>'booked'
     OR coalesce((v_replay->>'idempotent')::boolean,false) IS NOT TRUE
     OR (v_replay->>'sms_consent')::boolean IS NOT TRUE
     OR v_replay->>'notification_language'<>'en'
     OR (SELECT count(*) FROM public.booking_notifications n
       WHERE n.booking_id=v_booking_id)<>v_before_count THEN
    RAISE EXCEPTION 'public sequence replay-only receipt failed: %',v_replay;
  END IF;
  UPDATE public.salons SET slug='disposable-sequence-qa-renamed' WHERE id=v_salon;
  v_replay:=public.replay_public_booking_sequence(
    v_request||pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint',v_quote->>'pricing_fingerprint',
      'sms_consent',true,'notification_language','en'));
  IF v_replay->>'code'<>'booked'
     OR v_replay->>'salon_slug'<>'disposable-sequence-qa' THEN
    RAISE EXCEPTION 'public replay depended on mutable salon slug lookup: %',v_replay;
  END IF;
  UPDATE public.salons SET slug='disposable-sequence-qa' WHERE id=v_salon;
  v_changed:=public.replay_public_booking_sequence(
    v_request||pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint',v_quote->>'pricing_fingerprint',
      'sms_consent',false,'notification_language','en'));
  IF v_changed->>'code'<>'idempotency_conflict' THEN
    RAISE EXCEPTION 'changed replay SMS consent accepted: %',v_changed;
  END IF;
  v_changed:=public.replay_public_booking_sequence(
    v_request||pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint',v_quote->>'pricing_fingerprint',
      'sms_consent',true,'notification_language','vi'));
  IF v_changed->>'code'<>'idempotency_conflict' THEN
    RAISE EXCEPTION 'changed replay language accepted: %',v_changed;
  END IF;
  v_changed:=public.replay_public_booking_sequence(pg_catalog.jsonb_set(
    v_request||pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint',v_quote->>'pricing_fingerprint',
      'sms_consent',true,'notification_language','en'),
    '{request_id}','"40000000-0000-4000-8000-00000000000b"'::jsonb));
  IF v_changed->>'code'<>'replay_not_found' THEN
    RAISE EXCEPTION 'missing public replay did not stay read-only: %',v_changed;
  END IF;

  v_receipt := public.load_booking_sequence_receipt(v_salon, v_booking_id);
  IF v_receipt->>'code' <> 'loaded'
     OR v_receipt->>'pricing_fingerprint' <> v_quote->>'pricing_fingerprint'
     OR pg_catalog.jsonb_array_length(v_receipt->'segments') <> 2
     OR v_receipt#>>'{segments,0,staff_name}' IS NULL
     OR v_receipt#>>'{segments,0,promo_name}' <> 'Sequence Promo'
     OR (v_receipt#>>'{segments,0,email_discount_cents}')::integer <> 200
     OR (v_receipt#>>'{segments,0,voucher_discount_cents}')::integer < 1
     OR (v_receipt#>>'{segments,0,pre_voucher_subtotal_cents}')::integer < 1
     OR pg_catalog.jsonb_array_length(v_receipt#>'{segments,0,addon_lines}') <> 1 THEN
    RAISE EXCEPTION 'persisted receipt incomplete: %', v_receipt;
  END IF;
  v_cap := public.mint_booking_management_capability(
    v_salon, v_booking_id, 'status', v_start + interval '2 hours'
  );
  v_management := public.inspect_booking_management_capability_with_sequence(
    (v_cap->>'token_id')::uuid, 'status'
  );
  IF coalesce((v_management->>'ok')::boolean, false) IS NOT TRUE
     OR v_management#>>'{booking,schedule_model}' <> 'segments_v1'
     OR v_management#>>'{booking,sequence_receipt,pricing_fingerprint}'
        <> v_quote->>'pricing_fingerprint'
     OR pg_catalog.jsonb_array_length(
       v_management#>'{booking,sequence_receipt,segments}'
     ) <> 2 THEN
    RAISE EXCEPTION 'management sequence receipt wrapper failed: %', v_management;
  END IF;

  -- Flag-on one-line parity: authoritative single and sequence paths use the
  -- same catalog/promo/add-on/tax arithmetic, and the one-line path persists.
  v_one_line_request := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'salon_id', v_salon,
    'request_id', '40000000-0000-4000-8000-000000000003'::uuid,
    'requested_start_time_utc', v_start + interval '1 day',
    'lines', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'line_id', '50000000-0000-4000-8000-000000000003'::uuid,
      'position', 0, 'service_id', v_service_one,
      'staff_preference', v_staff_two::text, 'preferred_resource_id', NULL,
      'addon_service_ids', pg_catalog.jsonb_build_array(v_addon)
    )),
    'same_staff_for_all', false, 'voucher_code', NULL,
    'apply_email_discount', false,
    'customer', pg_catalog.jsonb_build_object(
      'name', 'Parity Customer', 'phone', '16045550198',
      'email', 'parity@example.test'
    )
  );
  v_one_line_quote := public.quote_public_booking_sequence(v_one_line_request);
  v_single_quote := public.resolve_public_booking_pricing(
    v_salon, v_service_one, v_staff_two,
    v_start + interval '1 day', v_start + interval '1 day 40 minutes',
    ARRAY[v_addon]::uuid[], NULL, NULL,
    '16045550198', 'parity@example.test', false, false
  );
  IF coalesce((v_one_line_quote->>'success')::boolean, false) IS NOT TRUE
     OR coalesce((v_single_quote->>'success')::boolean, false) IS NOT TRUE
     OR (v_one_line_quote->>'original_price_cents')::integer
        <> (v_single_quote->>'original_price_cents')::integer
     OR (v_one_line_quote->>'pre_voucher_subtotal_cents')::integer
        <> (v_single_quote->>'pre_voucher_subtotal_cents')::integer
     OR (v_one_line_quote->>'subtotal_cents')::integer
        <> (v_single_quote->>'subtotal_cents')::integer
     OR (v_one_line_quote->>'tax_cents')::integer
        <> (v_single_quote->>'tax_cents')::integer
     OR (v_one_line_quote->>'total_cents')::integer
        <> (v_single_quote->>'total_cents')::integer THEN
    RAISE EXCEPTION 'one-line parity failed: sequence=%, single=%',
      v_one_line_quote, v_single_quote;
  END IF;
  v_changed := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint', v_one_line_quote->>'pricing_fingerprint'
    )
  );
  IF coalesce((v_changed->>'success')::boolean, false) IS NOT TRUE
     OR pg_catalog.jsonb_array_length(v_changed->'segment_ids') <> 1 THEN
    RAISE EXCEPTION 'one-line sequence create failed: %', v_changed;
  END IF;

  -- Resource mode auto-assigns the first active free resource. A busy lower
  -- UUID must not cause a null assignment or reject the free second resource.
  INSERT INTO public.salon_resources(id, salon_id, name, kind, status) VALUES
    (v_resource_one, v_salon, 'Busy QA Room', 'room', 'active'),
    (v_resource_two, v_salon, 'Free QA Room', 'room', 'active');
  UPDATE public.salons SET resources_enabled = true WHERE id = v_salon;
  INSERT INTO public.bookings(
    salon_id, service_id, staff_id, resource_id, client_name, client_phone,
    start_time_utc, end_time_utc, status, source, schedule_model
  ) VALUES (
    v_salon, v_service_one, v_staff_two, v_resource_one,
    'Busy resource fixture', '16045550197',
    v_start + interval '2 days', v_start + interval '2 days 30 minutes',
    'confirmed', 'appointment', 'single'
  );
  v_one_line_request := pg_catalog.jsonb_build_object(
    'contract_version', 1, 'salon_id', v_salon,
    'request_id', '40000000-0000-4000-8000-000000000004'::uuid,
    'requested_start_time_utc', v_start + interval '2 days',
    'lines', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'line_id', '50000000-0000-4000-8000-000000000004'::uuid,
      'position', 0, 'service_id', v_service_one,
      'staff_preference', v_staff_one::text, 'preferred_resource_id', NULL,
      'addon_service_ids', '[]'::jsonb
    )),
    'same_staff_for_all', false, 'voucher_code', NULL,
    'apply_email_discount', false,
    'customer', pg_catalog.jsonb_build_object(
      'name', 'Resource Customer', 'phone', '16045550196',
      'email', 'resource@example.test'
    )
  );
  v_one_line_quote := public.quote_public_booking_sequence(v_one_line_request);
  IF v_one_line_quote#>>'{segments,0,resolved_resource_id}' <> v_resource_two::text THEN
    RAISE EXCEPTION 'auto resource did not choose exact free resource: %', v_one_line_quote;
  END IF;
  v_changed := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint', v_one_line_quote->>'pricing_fingerprint'
    )
  );
  IF coalesce((v_changed->>'success')::boolean, false) IS NOT TRUE
     OR v_changed#>>'{segments,0,resolved_resource_id}' <> v_resource_two::text THEN
    RAISE EXCEPTION 'auto resource create drifted: %', v_changed;
  END IF;
  v_resource_booking_id:=(v_changed->>'booking_id')::uuid;
  -- Active staff with live work cannot be deactivated after lifecycle
  -- hardening. Resource drift alone proves replay does not re-resolve anchors.
  UPDATE public.salon_resources SET status='inactive' WHERE id=v_resource_two;
  v_replay:=public.replay_public_booking_sequence(
    v_one_line_request||pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint',v_one_line_quote->>'pricing_fingerprint'));
  IF v_replay->>'code'<>'booked'
     OR v_replay->>'booking_id'<>v_resource_booking_id::text
     OR v_replay#>>'{segments,0,resolved_resource_id}'<>v_resource_two::text THEN
    RAISE EXCEPTION 'committed any-staff/resource replay drifted: %',v_replay;
  END IF;
  UPDATE public.salon_resources SET status='active' WHERE id=v_resource_two;

  -- A catalog change after quote must return a new quote before any business
  -- row is written for the new request.
  v_request_id := '40000000-0000-4000-8000-000000000002';
  v_request := pg_catalog.jsonb_set(
    pg_catalog.jsonb_set(v_request, '{request_id}', pg_catalog.to_jsonb(v_request_id)),
    '{voucher_code}', 'null'::jsonb
  );
  v_quote := public.quote_public_booking_sequence(v_request);
  SELECT count(*) INTO v_before_count FROM public.bookings b
  WHERE b.salon_id = v_salon AND b.idempotency_key = v_request_id;
  UPDATE public.services SET price_cents = price_cents + 1 WHERE id = v_service_two;
  v_changed := public.create_public_booking_sequence(
    v_request || pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF v_changed->>'code' <> 'pricing_changed'
     OR (SELECT count(*) FROM public.bookings b
         WHERE b.salon_id = v_salon AND b.idempotency_key = v_request_id) <> v_before_count THEN
    RAISE EXCEPTION 'pricing change did not fail with zero writes: %', v_changed;
  END IF;
  UPDATE public.services SET price_cents = price_cents - 1 WHERE id = v_service_two;

  -- A quote obtained under the supported Square card-only policy cannot be
  -- used after deposits are enabled. The create-side locked re-read must fail
  -- before any booking/profile write.
  v_one_line_request := pg_catalog.jsonb_set(
    v_one_line_request, '{request_id}',
    '"40000000-0000-4000-8000-000000000005"'::jsonb
  );
  v_one_line_request := pg_catalog.jsonb_set(
    v_one_line_request, '{requested_start_time_utc}',
    pg_catalog.to_jsonb(v_start + interval '3 days')
  );
  v_quote := public.quote_public_booking_sequence(v_one_line_request);
  UPDATE public.square_integrations SET deposit_enabled = true
  WHERE salon_id = v_salon;
  v_changed := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF v_changed->>'code' <> 'payment_not_supported'
     OR EXISTS (SELECT 1 FROM public.bookings b
       WHERE b.salon_id=v_salon
         AND b.idempotency_key='40000000-0000-4000-8000-000000000005') THEN
    RAISE EXCEPTION 'payment policy drift was not atomic/zero-write: %', v_changed;
  END IF;
  UPDATE public.square_integrations SET deposit_enabled = false
  WHERE salon_id = v_salon;

  -- OTP-disabled salons reject, rather than silently attach, a supplied
  -- session. Then enable OTP and prove missing, cross-phone, success,
  -- consumption/stamping, and exact committed replay.
  INSERT INTO public.salons(
    id, slug, name, phone, timezone, currency_code,
    subscription_plan, subscription_status, is_beta, feature_flags
  ) VALUES (
    v_other_salon, 'disposable-sequence-other', 'Disposable Sequence Other',
    '+16045550102', 'UTC', 'CAD', 'premium', 'active', true, '{}'::jsonb
  );
  INSERT INTO public.phone_otp_sessions(
    id, salon_id, phone, verified_at, expires_at
  ) VALUES
    (v_otp_session, v_salon, '16045550195', transaction_timestamp(),
      transaction_timestamp()+interval '15 minutes'),
    (v_other_otp_session, v_other_salon, '16045550195', transaction_timestamp(),
      transaction_timestamp()+interval '15 minutes'),
    (v_wrong_phone_otp_session, v_salon, '16045550999', transaction_timestamp(),
      transaction_timestamp()+interval '15 minutes');
  v_one_line_request := pg_catalog.jsonb_set(
    v_one_line_request, '{request_id}',
    '"40000000-0000-4000-8000-000000000006"'::jsonb
  );
  v_one_line_request := pg_catalog.jsonb_set(
    v_one_line_request, '{requested_start_time_utc}',
    pg_catalog.to_jsonb(v_start + interval '4 days')
  );
  v_one_line_request := pg_catalog.jsonb_set(
    v_one_line_request, '{customer,phone}', '"16045550195"'::jsonb
  );
  v_quote := public.quote_public_booking_sequence(v_one_line_request);
  v_changed := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'otp_session_id', v_otp_session,
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF v_changed->>'code' <> 'otp_not_required'
     OR EXISTS (SELECT 1 FROM public.bookings b
       WHERE b.salon_id=v_salon
         AND b.idempotency_key='40000000-0000-4000-8000-000000000006') THEN
    RAISE EXCEPTION 'OTP-disabled supplied session was not rejected: %', v_changed;
  END IF;

  UPDATE public.salons SET phone_otp_enabled = true WHERE id = v_salon;
  v_changed := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF v_changed->>'code' <> 'otp_required' THEN
    RAISE EXCEPTION 'OTP-required create accepted no session: %', v_changed;
  END IF;
  v_changed := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'otp_session_id', v_other_otp_session,
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF v_changed->>'code' <> 'invalid_otp_session' THEN
    RAISE EXCEPTION 'cross-salon OTP session accepted: %', v_changed;
  END IF;
  v_changed := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'otp_session_id', v_wrong_phone_otp_session,
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF v_changed->>'code' <> 'invalid_otp_session' THEN
    RAISE EXCEPTION 'cross-phone OTP session accepted: %', v_changed;
  END IF;
  v_created := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'otp_session_id', v_otp_session,
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  v_otp_booking_id := nullif(v_created->>'booking_id', '')::uuid;
  IF v_created->>'code' <> 'booked' OR v_otp_booking_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.bookings b
       WHERE b.id=v_otp_booking_id AND b.otp_session_id=v_otp_session
         AND b.verification_method='otp'
         AND b.verification_completed_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.phone_otp_sessions otp
       WHERE otp.id=v_otp_session AND otp.consumed_at IS NOT NULL
         AND otp.consumed_by_booking_id=v_otp_booking_id)
     OR NOT EXISTS (SELECT 1 FROM public.client_profiles cp
       WHERE cp.id=(SELECT b.client_profile_id FROM public.bookings b
         WHERE b.id=v_otp_booking_id) AND cp.phone_verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'atomic OTP create/stamp/consume failed: %', v_created;
  END IF;
  v_replay := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'otp_session_id', v_otp_session,
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF coalesce((v_replay->>'idempotent')::boolean, false) IS NOT TRUE
     OR v_replay->>'booking_id' <> v_otp_booking_id::text THEN
    RAISE EXCEPTION 'consumed OTP exact replay failed: %', v_replay;
  END IF;
  v_changed := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'otp_session_id', v_other_otp_session,
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF v_changed->>'code' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'OTP bearer-switched replay was accepted: %', v_changed;
  END IF;
  UPDATE public.salons SET phone_otp_enabled = false WHERE id = v_salon;
  v_replay:=public.replay_public_booking_sequence(
    v_one_line_request||pg_catalog.jsonb_build_object(
      'otp_session_id',v_otp_session,
      'expected_pricing_fingerprint',v_quote->>'pricing_fingerprint'));
  IF v_replay->>'code'<>'booked'
     OR v_replay->>'booking_id'<>v_otp_booking_id::text THEN
    RAISE EXCEPTION 'OTP replay-only recovery depended on current OTP gate: %',v_replay;
  END IF;

  -- Health acknowledgment is a create-only legal fact. The authoritative
  -- salon/vertical policy is locked in create, true is request-bound and
  -- stamped atomically, and exact replay retains the same evidence.
  UPDATE public.salons SET health_ack_required = true WHERE id = v_salon;
  v_one_line_request := pg_catalog.jsonb_set(
    v_one_line_request, '{request_id}',
    '"40000000-0000-4000-8000-000000000007"'::jsonb
  );
  v_one_line_request := pg_catalog.jsonb_set(
    v_one_line_request, '{requested_start_time_utc}',
    pg_catalog.to_jsonb(v_start + interval '5 days')
  );
  v_quote := public.quote_public_booking_sequence(v_one_line_request);
  v_changed := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF v_changed->>'code' <> 'health_ack_required'
     OR EXISTS (SELECT 1 FROM public.bookings b
       WHERE b.salon_id=v_salon
         AND b.idempotency_key='40000000-0000-4000-8000-000000000007') THEN
    RAISE EXCEPTION 'required health acknowledgment was not zero-write: %', v_changed;
  END IF;
  v_created := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'health_acknowledged', true,
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF v_created->>'code' <> 'booked'
     OR NOT EXISTS (SELECT 1 FROM public.bookings b
       WHERE b.id=(v_created->>'booking_id')::uuid AND b.health_ack_at IS NOT NULL) THEN
    RAISE EXCEPTION 'health acknowledgment was not atomically stamped: %', v_created;
  END IF;
  v_replay := public.create_public_booking_sequence(
    v_one_line_request || pg_catalog.jsonb_build_object(
      'health_acknowledged', true,
      'expected_pricing_fingerprint', v_quote->>'pricing_fingerprint'
    )
  );
  IF coalesce((v_replay->>'idempotent')::boolean, false) IS NOT TRUE
     OR v_replay->>'booking_id' <> v_created->>'booking_id' THEN
    RAISE EXCEPTION 'health acknowledgment replay lost evidence: %', v_replay;
  END IF;
  UPDATE public.salons SET health_ack_required = NULL WHERE id = v_salon;
  v_replay:=public.replay_public_booking_sequence(
    v_one_line_request||pg_catalog.jsonb_build_object(
      'health_acknowledged',true,
      'expected_pricing_fingerprint',v_quote->>'pricing_fingerprint'));
  IF v_replay->>'code'<>'booked'
     OR v_replay->>'booking_id'<>v_created->>'booking_id' THEN
    RAISE EXCEPTION 'health replay-only recovery lost persisted evidence: %',v_replay;
  END IF;

  -- Whole-sequence reschedule: quote from persisted line preferences, force a
  -- failure after segment N to prove statement rollback, then commit all child
  -- capacity + parent anchors + receipt + transition occurrence atomically.
  SELECT b.public_booking_pricing_snapshot,b.start_time_utc
  INTO STRICT v_old_snapshot,v_old_parent_start FROM public.bookings b
  WHERE b.id=v_booking_id;
  v_sequence_cap:=public.mint_booking_management_capability(
    v_salon,v_booking_id,'reschedule',v_start+interval '1 hour'
  );
  v_sequence_quote:=public.quote_booking_sequence_reschedule(
    (v_sequence_cap->>'token_id')::uuid,
    '70000000-0000-4000-8000-000000000001'::uuid,
    v_start+interval '6 days'
  );
  IF v_sequence_quote->>'code'<>'reschedule_quoted'
     OR pg_catalog.jsonb_array_length(v_sequence_quote->'schedule_segments')<>2 THEN
    RAISE EXCEPTION 'sequence reschedule quote failed: %',v_sequence_quote;
  END IF;
  BEGIN
    v_changed:=public.reschedule_booking_sequence_with_management_capability(
      (v_sequence_cap->>'token_id')::uuid,
      '70000000-0000-4000-8000-000000000001'::uuid,
      v_start+interval '6 days',v_sequence_quote->>'sequence_fingerprint'
    );
    RAISE EXCEPTION 'forced sequence reschedule unexpectedly committed: %',v_changed;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'forced sequence reschedule segment failure%' THEN RAISE; END IF;
  END;
  IF (SELECT b.start_time_utc FROM public.bookings b WHERE b.id=v_booking_id)
       IS DISTINCT FROM v_old_parent_start
     OR (SELECT b.public_booking_pricing_snapshot FROM public.bookings b WHERE b.id=v_booking_id)
       IS DISTINCT FROM v_old_snapshot
     OR EXISTS (SELECT 1 FROM public.booking_service_segments seg
       JOIN LATERAL pg_catalog.jsonb_array_elements(v_old_snapshot->'segments') old_line(value)
         ON old_line.value->>'line_id'=seg.line_id::text
       WHERE seg.booking_id=v_booking_id
         AND seg.customer_start_utc IS DISTINCT FROM
           (old_line.value->>'customer_start_utc')::timestamptz)
     OR EXISTS (SELECT 1 FROM public.booking_management_capabilities c
       WHERE c.id=(v_sequence_cap->>'token_id')::uuid AND c.consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'forced sequence reschedule did not roll back every write';
  END IF;
  DROP TRIGGER qa_fail_second_sequence_reschedule_segment
    ON public.booking_service_segments;
  v_created:=public.reschedule_booking_sequence_with_management_capability(
    (v_sequence_cap->>'token_id')::uuid,
    '70000000-0000-4000-8000-000000000001'::uuid,
    v_start+interval '6 days',v_sequence_quote->>'sequence_fingerprint'
  );
  IF v_created->>'code'<>'rescheduled'
     OR coalesce((v_created->>'idempotent')::boolean,true)
     OR v_created->>'sequence_fingerprint'<>v_sequence_quote->>'sequence_fingerprint'
     OR coalesce((v_created->>'customer_transition_sms_requested')::boolean,true)
     OR pg_catalog.jsonb_array_length(v_created#>'{sequence_receipt,segments}')<>2
     OR (SELECT b.start_time_utc FROM public.bookings b WHERE b.id=v_booking_id)
        IS DISTINCT FROM (v_sequence_quote->>'parent_start_time_utc')::timestamptz
     OR EXISTS (SELECT 1 FROM public.booking_service_segments seg
       WHERE seg.booking_id=v_booking_id AND seg.reservation_status<>'confirmed')
     OR NOT EXISTS (SELECT 1 FROM public.customer_booking_transition_email_outbox outbox
       WHERE outbox.booking_id=v_booking_id AND outbox.event_type='reschedule'
         AND outbox.transition_version=(v_created->>'customer_transition_version')::bigint) THEN
    RAISE EXCEPTION 'atomic full-sequence reschedule failed: %',v_created;
  END IF;
  -- Old capacity is released only after the successful move.
  INSERT INTO public.bookings(
    salon_id,service_id,staff_id,resource_id,client_name,client_phone,
    start_time_utc,end_time_utc,status,source,schedule_model
  ) VALUES(
    v_salon,v_service_one,v_staff_one,v_resource_two,
    'Released capacity proof','16045550194',
    v_old_parent_start,v_old_parent_start+interval '10 minutes',
    'confirmed','appointment','single'
  );
  v_replay:=public.reschedule_booking_sequence_with_management_capability(
    (v_sequence_cap->>'token_id')::uuid,
    '70000000-0000-4000-8000-000000000001'::uuid,
    v_start+interval '6 days',v_sequence_quote->>'sequence_fingerprint'
  );
  IF coalesce((v_replay->>'idempotent')::boolean,false) IS NOT TRUE
     OR v_replay->'sequence_receipt' IS DISTINCT FROM v_created->'sequence_receipt' THEN
    RAISE EXCEPTION 'sequence reschedule exact replay drifted: %',v_replay;
  END IF;
  v_changed:=public.reschedule_booking_sequence_with_management_capability(
    (v_sequence_cap->>'token_id')::uuid,
    '70000000-0000-4000-8000-000000000001'::uuid,
    v_start+interval '6 days 1 minute',v_sequence_quote->>'sequence_fingerprint'
  );
  IF v_changed->>'code'<>'idempotency_mismatch' THEN
    RAISE EXCEPTION 'changed sequence reschedule replay accepted: %',v_changed;
  END IF;

  -- An external capacity claim after quote must make apply fail with no parent,
  -- child, transition, or capability-consumption write.
  SELECT b.id INTO STRICT v_conflict_booking FROM public.bookings b
  WHERE b.salon_id=v_salon
    AND b.idempotency_key='40000000-0000-4000-8000-000000000003';
  v_conflict_cap:=public.mint_booking_management_capability(
    v_salon,v_conflict_booking,'reschedule',v_start+interval '1 hour'
  );
  v_conflict_quote:=public.quote_booking_sequence_reschedule(
    (v_conflict_cap->>'token_id')::uuid,
    '70000000-0000-4000-8000-000000000002'::uuid,
    v_start+interval '7 days'
  );
  v_conflict_start:=(v_conflict_quote#>>'{schedule_segments,0,occupied_start_utc}')::timestamptz;
  v_conflict_end:=(v_conflict_quote#>>'{schedule_segments,0,occupied_end_utc}')::timestamptz;
  v_conflict_staff:=(v_conflict_quote#>>'{schedule_segments,0,staff_id}')::uuid;
  v_conflict_resource:=nullif(
    v_conflict_quote#>>'{schedule_segments,0,resource_id}',''
  )::uuid;
  INSERT INTO public.bookings(
    salon_id,service_id,staff_id,resource_id,client_name,client_phone,
    start_time_utc,end_time_utc,status,source,schedule_model
  ) VALUES(v_salon,v_service_one,v_conflict_staff,v_conflict_resource,
    'Conflict proof','16045550193',
    v_conflict_start,v_conflict_end,'confirmed','appointment','single');
  v_old_parent_start:=(SELECT b.start_time_utc FROM public.bookings b WHERE b.id=v_conflict_booking);
  v_changed:=public.reschedule_booking_sequence_with_management_capability(
    (v_conflict_cap->>'token_id')::uuid,
    '70000000-0000-4000-8000-000000000002'::uuid,
    v_start+interval '7 days',v_conflict_quote->>'sequence_fingerprint'
  );
  IF v_changed->>'code'<>'slot_conflict'
     OR (SELECT b.start_time_utc FROM public.bookings b WHERE b.id=v_conflict_booking)
       IS DISTINCT FROM v_old_parent_start
     OR EXISTS (SELECT 1 FROM public.booking_management_capabilities c
       WHERE c.id=(v_conflict_cap->>'token_id')::uuid AND c.consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'sequence slot race was not zero-write: %',v_changed;
  END IF;

  -- A sequence that crosses Vancouver's repeated fall-back hour is rejected
  -- because the authoritative single-line pricing contract requires local end
  -- time to remain after local start time. A post-transition five-line sequence
  -- remains valid and moves atomically; local-close overflow stays fail-closed.
  UPDATE public.salons SET timezone='America/Vancouver',resources_enabled=false
  WHERE id=v_salon;
  v_dst_date:=pg_catalog.make_date(
    extract(year FROM transaction_timestamp())::integer+1,11,1
  );
  v_dst_date:=v_dst_date+((7-extract(dow FROM v_dst_date)::integer)%7);
  v_dst_start:=(v_dst_date::timestamp+time '00:30') AT TIME ZONE 'America/Vancouver';
  v_five_request:=pg_catalog.jsonb_build_object(
    'contract_version',1,'salon_id',v_salon,
    'request_id','40000000-0000-4000-8000-000000000008'::uuid,
    'requested_start_time_utc',v_dst_start,
    'lines',pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('line_id','50000000-0000-4000-8000-000000000010'::uuid,
        'position',0,'service_id',v_service_one,'staff_preference',v_staff_one::text,
        'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb),
      pg_catalog.jsonb_build_object('line_id','50000000-0000-4000-8000-000000000011'::uuid,
        'position',1,'service_id',v_service_one,'staff_preference',v_staff_two::text,
        'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb),
      pg_catalog.jsonb_build_object('line_id','50000000-0000-4000-8000-000000000012'::uuid,
        'position',2,'service_id',v_service_one,'staff_preference',v_staff_one::text,
        'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb),
      pg_catalog.jsonb_build_object('line_id','50000000-0000-4000-8000-000000000013'::uuid,
        'position',3,'service_id',v_service_one,'staff_preference',v_staff_two::text,
        'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb),
      pg_catalog.jsonb_build_object('line_id','50000000-0000-4000-8000-000000000014'::uuid,
        'position',4,'service_id',v_service_one,'staff_preference',v_staff_one::text,
        'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb)
    ),
    'same_staff_for_all',false,'voucher_code',NULL,'apply_email_discount',false,
    'customer',pg_catalog.jsonb_build_object('name','DST Sequence Customer',
      'phone','16045550192','email','dst-sequence@example.test')
  );
  v_five_quote:=public.quote_public_booking_sequence(v_five_request);
  IF v_five_quote->>'code'<>'outside_hours' THEN
    RAISE EXCEPTION 'fall-back ambiguous sequence was not rejected: %',v_five_quote;
  END IF;
  v_dst_start:=(v_dst_date::timestamp+time '03:30') AT TIME ZONE 'America/Vancouver';
  v_five_request:=pg_catalog.jsonb_set(
    v_five_request,'{requested_start_time_utc}',pg_catalog.to_jsonb(v_dst_start)
  );
  v_five_quote:=public.quote_public_booking_sequence(v_five_request);
  IF v_five_quote->>'code'<>'quoted'
     OR pg_catalog.jsonb_array_length(v_five_quote->'segments')<>5
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_five_quote->'segments') a(value)
       JOIN pg_catalog.jsonb_array_elements(v_five_quote->'segments') b(value)
         ON (b.value->>'position')::integer=(a.value->>'position')::integer+1
       WHERE (b.value->>'customer_start_utc')::timestamptz
         < (a.value->>'customer_end_utc')::timestamptz) THEN
    RAISE EXCEPTION 'five-line DST quote invalid: %',v_five_quote;
  END IF;
  v_changed:=public.quote_public_booking_sequence(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(v_five_request,'{request_id}',
        '"40000000-0000-4000-8000-000000000009"'::jsonb),
      '{requested_start_time_utc}',
      pg_catalog.to_jsonb((v_dst_date::timestamp+time '23:50') AT TIME ZONE 'America/Vancouver')
    )
  );
  IF v_changed->>'code'<>'outside_hours' THEN
    RAISE EXCEPTION 'sequence local close was not enforced: %',v_changed;
  END IF;
  v_five_created:=public.create_public_booking_sequence(
    v_five_request||pg_catalog.jsonb_build_object(
      'expected_pricing_fingerprint',v_five_quote->>'pricing_fingerprint'
    )
  );
  v_five_booking:=nullif(v_five_created->>'booking_id','')::uuid;
  IF v_five_created->>'code'<>'booked' OR v_five_booking IS NULL
     OR (SELECT count(*) FROM public.booking_service_segments seg
       WHERE seg.booking_id=v_five_booking)<>5 THEN
    RAISE EXCEPTION 'five-line sequence create failed: %',v_five_created;
  END IF;
  v_five_cap:=public.mint_booking_management_capability(
    v_salon,v_five_booking,'reschedule',transaction_timestamp()+interval '1 day'
  );
  v_sequence_quote:=public.quote_booking_sequence_reschedule(
    (v_five_cap->>'token_id')::uuid,
    '70000000-0000-4000-8000-000000000003'::uuid,
    v_dst_start+interval '1 day'
  );
  v_created:=public.reschedule_booking_sequence_with_management_capability(
    (v_five_cap->>'token_id')::uuid,
    '70000000-0000-4000-8000-000000000003'::uuid,
    v_dst_start+interval '1 day',v_sequence_quote->>'sequence_fingerprint'
  );
  IF v_created->>'code'<>'rescheduled'
     OR pg_catalog.jsonb_array_length(v_created#>'{sequence_receipt,segments}')<>5
     OR (SELECT count(DISTINCT seg.line_id) FROM public.booking_service_segments seg
       WHERE seg.booking_id=v_five_booking)<>5 THEN
    RAISE EXCEPTION 'five-line repeated-service reschedule failed: %',v_created;
  END IF;

  -- Desk wrapper marker: actor identity and the explicit no-email choice are
  -- transaction-bound, and response-loss replay returns the same receipt
  -- without creating a second transition occurrence.
  v_sequence_quote:=public.quote_booking_sequence_reschedule_for_desk(
    v_salon,v_five_booking,v_desk_actor,
    '70000000-0000-4000-8000-000000000004'::uuid,
    v_dst_start+interval '2 days'
  );
  IF v_sequence_quote->>'code'<>'reschedule_quoted' THEN
    RAISE EXCEPTION 'desk sequence quote failed: %',v_sequence_quote;
  END IF;
  v_created:=public.reschedule_booking_sequence_for_desk(
    v_salon,v_five_booking,v_desk_actor,false,false,
    '70000000-0000-4000-8000-000000000004'::uuid,
    v_dst_start+interval '2 days',v_sequence_quote->>'sequence_fingerprint'
  );
  IF v_created->>'code'<>'rescheduled'
     OR v_created->>'actor_source'<>'staff'
     OR (v_created->>'actor_user_id')::uuid<>v_desk_actor
     OR (v_created->>'customer_transition_email_requested')::boolean
     OR (v_created->>'customer_transition_sms_requested')::boolean
     OR (SELECT b.rescheduled_by FROM public.bookings b WHERE b.id=v_five_booking)<>'staff'
     OR EXISTS (
       SELECT 1 FROM public.customer_booking_transition_email_outbox o
       WHERE o.booking_id=v_five_booking
         AND o.transition_version=(v_created->>'customer_transition_version')::bigint
     )
     OR EXISTS (
       SELECT 1 FROM public.staff_action_notification_outbox o
       WHERE o.booking_id=v_five_booking AND o.request_id=
         '70000000-0000-4000-8000-000000000004'::uuid
     ) THEN
    RAISE EXCEPTION 'desk actor/notification contract failed: %',v_created;
  END IF;
  v_replay:=public.reschedule_booking_sequence_for_desk(
    v_salon,v_five_booking,v_desk_actor,false,false,
    '70000000-0000-4000-8000-000000000004'::uuid,
    v_dst_start+interval '2 days',v_sequence_quote->>'sequence_fingerprint'
  );
  IF v_replay->>'code'<>'rescheduled'
     OR coalesce((v_replay->>'idempotent')::boolean,false) IS NOT TRUE
     OR (v_replay->>'customer_transition_version')::bigint
       <> (v_created->>'customer_transition_version')::bigint THEN
    RAISE EXCEPTION 'desk exact response-loss replay failed: %',v_replay;
  END IF;
  v_replay:=public.replay_booking_sequence_reschedule_for_desk(
    v_salon,v_five_booking,v_desk_actor,false,false,
    '70000000-0000-4000-8000-000000000004'::uuid,
    v_dst_start+interval '2 days',v_sequence_quote->>'sequence_fingerprint'
  );
  IF v_replay->>'code'<>'rescheduled'
     OR coalesce((v_replay->>'idempotent')::boolean,false) IS NOT TRUE
     OR (v_replay->>'customer_transition_version')::bigint
       <> (v_created->>'customer_transition_version')::bigint THEN
    RAISE EXCEPTION 'desk replay-only depended on current staff anchor: %',v_replay;
  END IF;
  v_changed:=public.reschedule_booking_sequence_for_desk(
    v_salon,v_five_booking,v_desk_actor,false,true,
    '70000000-0000-4000-8000-000000000004'::uuid,
    v_dst_start+interval '2 days',v_sequence_quote->>'sequence_fingerprint'
  );
  IF v_changed->>'code'<>'idempotency_mismatch'
     OR (SELECT count(*) FROM public.customer_booking_transition_email_outbox o
       WHERE o.booking_id=v_five_booking
         AND o.transition_version=(v_created->>'customer_transition_version')::bigint)<>0
     OR EXISTS (SELECT 1 FROM public.staff_action_notification_outbox o
       WHERE o.salon_id=v_salon AND o.request_id=
         '70000000-0000-4000-8000-000000000004'::uuid) THEN
    RAISE EXCEPTION 'desk changed notify replay was not rejected: %',v_changed;
  END IF;

  -- A separate explicit SMS=true desk action persists that choice once. Its
  -- exact response-loss replay returns the same transition and cannot create a
  -- second notification row or transition occurrence.
  v_sequence_quote:=public.quote_booking_sequence_reschedule_for_desk(
    v_salon,v_five_booking,v_desk_actor,
    '70000000-0000-4000-8000-000000000005'::uuid,
    v_dst_start+interval '3 days'
  );
  SELECT count(*) INTO v_before_count FROM public.booking_notifications n
  WHERE n.booking_id=v_five_booking;
  v_created:=public.reschedule_booking_sequence_for_desk(
    v_salon,v_five_booking,v_desk_actor,false,true,
    '70000000-0000-4000-8000-000000000005'::uuid,
    v_dst_start+interval '3 days',v_sequence_quote->>'sequence_fingerprint'
  );
  IF v_created->>'code'<>'rescheduled'
     OR coalesce((v_created->>'customer_transition_sms_requested')::boolean,false)
       IS NOT TRUE
     OR NOT EXISTS (SELECT 1 FROM public.staff_action_notification_outbox o
       JOIN public.staff_action_notification_deliveries d ON d.outbox_id=o.id
       WHERE o.salon_id=v_salon AND o.request_id=
         '70000000-0000-4000-8000-000000000005'::uuid
         AND o.requested_channels='{"sms":true,"email":false}'::jsonb
         AND d.channel='sms')
     OR EXISTS (SELECT 1 FROM public.customer_booking_transition_email_outbox o
       WHERE o.booking_id=v_five_booking
         AND o.transition_version=(v_created->>'customer_transition_version')::bigint) THEN
    RAISE EXCEPTION 'desk SMS=true choice was not durably recorded: %',v_created;
  END IF;
  v_replay:=public.replay_booking_sequence_reschedule_for_desk(
    v_salon,v_five_booking,v_desk_actor,false,true,
    '70000000-0000-4000-8000-000000000005'::uuid,
    v_dst_start+interval '3 days',v_sequence_quote->>'sequence_fingerprint'
  );
  IF v_replay->>'code'<>'rescheduled'
     OR coalesce((v_replay->>'idempotent')::boolean,false) IS NOT TRUE
     OR coalesce((v_replay->>'customer_transition_sms_requested')::boolean,false)
       IS NOT TRUE
     OR (v_replay->>'customer_transition_version')::bigint
       <> (v_created->>'customer_transition_version')::bigint
     OR (SELECT count(*) FROM public.booking_notifications n
       WHERE n.booking_id=v_five_booking)<>v_before_count THEN
    RAISE EXCEPTION 'desk SMS=true replay duplicated or drifted: %',v_replay;
  END IF;

  -- Closed-day/open-close/DST marker. The five-line quote/create above proves
  -- ordered work across Vancouver's fall-back boundary; this exact Sunday
  -- closure must override otherwise-valid 00:30 local availability.
  UPDATE public.salons
  SET opening_hours = pg_catalog.jsonb_set(
    opening_hours, '{sun,closed}', 'true'::jsonb, false
  )
  WHERE id = v_salon;
  v_changed:=public.quote_public_booking_sequence(
    pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(v_five_request,'{request_id}',
        '"40000000-0000-4000-8000-00000000000a"'::jsonb),
      '{requested_start_time_utc}',pg_catalog.to_jsonb(v_dst_start+interval '7 days')
    )
  );
  IF v_changed->>'code'<>'outside_hours' THEN
    RAISE EXCEPTION 'closed Sunday did not override DST/open hours: %',v_changed;
  END IF;
  UPDATE public.salons
  SET opening_hours = pg_catalog.jsonb_set(
    opening_hours, '{sun,closed}', 'false'::jsonb, false
  )
  WHERE id = v_salon;

  -- Fingerprint drift matrix. Retry identity/contact is deliberately separate
  -- from the pricing/schedule fingerprint; every schedule/pricing preference
  -- and derived timing fact must change it, while create replay binds contact.
  DECLARE
    v_matrix jsonb;
    v_base jsonb;
    v_variant jsonb;
    v_matrix_local_date date;
    v_shift_day text;
  BEGIN
    v_matrix:=pg_catalog.jsonb_build_object(
      'contract_version',1,'salon_id',v_salon,
      'request_id','40000000-0000-4000-8000-000000000010'::uuid,
      'requested_start_time_utc',v_start+interval '10 days',
      'lines',pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('line_id','50000000-0000-4000-8000-000000000020'::uuid,
          'position',0,'service_id',v_service_one,'staff_preference',v_staff_one::text,
          'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb),
        pg_catalog.jsonb_build_object('line_id','50000000-0000-4000-8000-000000000021'::uuid,
          'position',1,'service_id',v_service_two,'staff_preference',v_staff_two::text,
          'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb)
      ),'same_staff_for_all',false,'voucher_code',NULL,
      'apply_email_discount',false,
      'customer',pg_catalog.jsonb_build_object('name','Matrix Customer',
        'phone','16045550191','email','matrix@example.test')
    );
    v_base:=public.quote_public_booking_sequence(v_matrix);
    IF v_base->>'code'<>'quoted' THEN RAISE EXCEPTION 'matrix base failed: %',v_base; END IF;

    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(v_matrix,'{lines,0,service_id}',pg_catalog.to_jsonb(v_service_two)),
      '{lines,1,service_id}',pg_catalog.to_jsonb(v_service_one)));
    IF v_variant->>'code'<>'quoted'
       OR v_variant->>'pricing_fingerprint'=v_base->>'pricing_fingerprint' THEN
      RAISE EXCEPTION 'line order/service sequence missing from pricing fingerprint';
    END IF;
    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      v_matrix,'{lines,0,staff_preference}',pg_catalog.to_jsonb(v_staff_two::text)));
    IF v_variant->>'code'<>'quoted'
       OR v_variant->>'pricing_fingerprint'=v_base->>'pricing_fingerprint' THEN
      RAISE EXCEPTION 'staff preference/assignment missing from pricing fingerprint';
    END IF;
    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      v_matrix,'{lines,0,preferred_resource_id}',pg_catalog.to_jsonb(v_resource_one)));
    IF v_variant->>'code'<>'quoted'
       OR v_variant->>'pricing_fingerprint'=v_base->>'pricing_fingerprint' THEN
      RAISE EXCEPTION 'resource preference/assignment missing from pricing fingerprint';
    END IF;
    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      v_matrix,'{requested_start_time_utc}',pg_catalog.to_jsonb(v_start+interval '10 days 1 hour')));
    IF v_variant->>'code'<>'quoted'
       OR v_variant->>'pricing_fingerprint'=v_base->>'pricing_fingerprint' THEN
      RAISE EXCEPTION 'requested start missing from pricing fingerprint';
    END IF;
    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      v_matrix,'{lines,0,addon_service_ids}',pg_catalog.jsonb_build_array(v_addon)));
    IF v_variant->>'code'<>'quoted'
       OR v_variant->>'pricing_fingerprint'=v_base->>'pricing_fingerprint' THEN
      RAISE EXCEPTION 'add-ons missing from pricing fingerprint';
    END IF;
    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      v_matrix,'{voucher_code}','"SEQ-MATRIX"'::jsonb));
    IF v_variant->>'code'<>'quoted'
       OR v_variant->>'pricing_fingerprint'=v_base->>'pricing_fingerprint' THEN
      RAISE EXCEPTION 'voucher allocation missing from pricing fingerprint';
    END IF;
    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      pg_catalog.jsonb_set(v_matrix,'{customer,phone}','"16045550190"'::jsonb),
      '{customer,email}','"matrix-changed@example.test"'::jsonb));
    IF v_variant->>'code'<>'quoted'
       OR v_variant->>'pricing_fingerprint'<>v_base->>'pricing_fingerprint' THEN
      RAISE EXCEPTION 'contact leaked into pricing fingerprint separation';
    END IF;
    UPDATE public.services SET prep_minutes=prep_minutes+1 WHERE id=v_service_one;
    v_variant:=public.quote_public_booking_sequence(v_matrix);
    UPDATE public.services SET prep_minutes=prep_minutes-1 WHERE id=v_service_one;
    IF v_variant->>'code'<>'quoted'
       OR v_variant->>'pricing_fingerprint'=v_base->>'pricing_fingerprint' THEN
      RAISE EXCEPTION 'derived prep timing missing from pricing fingerprint';
    END IF;
    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      v_matrix,'{contract_version}','2'::jsonb));
    IF v_variant->>'code'<>'unsupported_contract' THEN
      RAISE EXCEPTION 'contract version did not fail closed: %',v_variant;
    END IF;

    -- Staff-unavailability marker: a one-off day block is authoritative even
    -- for an explicitly requested active/capable staff member.
    INSERT INTO public.staff_unavailability(staff_id,salon_id,date,reason)
    VALUES(v_staff_one,v_salon,
      ((v_start+interval '10 days') AT TIME ZONE 'America/Vancouver')::date,
      'sequence rehearsal');
    v_variant:=public.quote_public_booking_sequence(v_matrix);
    IF v_variant->>'code'<>'staff_unavailable' THEN
      RAISE EXCEPTION 'staff one-off unavailability not enforced: %',v_variant;
    END IF;
    DELETE FROM public.staff_unavailability
    WHERE staff_id=v_staff_one AND salon_id=v_salon AND reason='sequence rehearsal';

    -- Staff shift/break markers. A recurring shift rejects a request outside
    -- its local bounds; a service whose occupied interval crosses the break is
    -- rejected, while prep ending exactly at break_end is non-overlapping.
    v_matrix_local_date:=((v_start+interval '10 days')
      AT TIME ZONE 'America/Vancouver')::date;
    v_shift_day:=(ARRAY['sun','mon','tue','wed','thu','fri','sat'])[
      extract(dow FROM v_matrix_local_date)::integer+1
    ];
    INSERT INTO public.staff_shifts(
      staff_id,salon_id,day_of_week,start_time,end_time,is_active,
      break_start_time,break_end_time
    ) VALUES(v_staff_one,v_salon,v_shift_day,'09:00','17:00',true,
      time '12:00',time '13:00');
    v_variant:=public.quote_public_booking_sequence(v_matrix);
    IF v_variant->>'code'<>'staff_unavailable' THEN
      RAISE EXCEPTION 'outside-shift sequence was accepted: %',v_variant;
    END IF;
    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      v_matrix,'{requested_start_time_utc}',pg_catalog.to_jsonb(
        (v_matrix_local_date::timestamp+time '12:15')
          AT TIME ZONE 'America/Vancouver')));
    IF v_variant->>'code'<>'staff_unavailable' THEN
      RAISE EXCEPTION 'staff-break crossing sequence was accepted: %',v_variant;
    END IF;
    v_variant:=public.quote_public_booking_sequence(pg_catalog.jsonb_set(
      v_matrix,'{requested_start_time_utc}',pg_catalog.to_jsonb(
        (v_matrix_local_date::timestamp+time '13:05')
          AT TIME ZONE 'America/Vancouver')));
    IF v_variant->>'code'<>'quoted' THEN
      RAISE EXCEPTION 'break-adjacent non-overlap sequence was rejected: %',v_variant;
    END IF;
    DELETE FROM public.staff_shifts
    WHERE staff_id=v_staff_one AND salon_id=v_salon AND day_of_week=v_shift_day;

    -- same_staff intersection marker: once a salon has an explicit capability
    -- whitelist, split-only mappings must fail; adding one real intersection
    -- must resolve every ordered line to that same staff member.
    INSERT INTO public.staff_services(staff_id,service_id) VALUES
      (v_staff_one,v_service_one),(v_staff_two,v_service_two);
    v_variant:=public.quote_public_booking_sequence(
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(v_matrix,'{same_staff_for_all}','true'::jsonb),
          '{lines,0,staff_preference}','"any"'::jsonb),
        '{lines,1,staff_preference}','"any"'::jsonb)
    );
    IF v_variant->>'code'<>'no_staff_available' THEN
      RAISE EXCEPTION 'split capability mappings created a false common staff: %',v_variant;
    END IF;
    INSERT INTO public.staff_services(staff_id,service_id)
    VALUES(v_staff_one,v_service_two);
    v_variant:=public.quote_public_booking_sequence(
      pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(v_matrix,'{same_staff_for_all}','true'::jsonb),
          '{lines,0,staff_preference}','"any"'::jsonb),
        '{lines,1,staff_preference}','"any"'::jsonb)
    );
    IF v_variant->>'code'<>'quoted'
       OR EXISTS (
         SELECT 1 FROM pg_catalog.jsonb_array_elements(v_variant->'segments') seg(value)
         WHERE seg.value->>'staff_id'<>v_staff_one::text
       ) THEN
      RAISE EXCEPTION 'valid common-staff intersection was not enforced: %',v_variant;
    END IF;
  END;

  -- Cancellation releases every segment in the same transaction.
  UPDATE public.bookings SET status = 'cancelled' WHERE id = v_booking_id;
  IF EXISTS (SELECT 1 FROM public.booking_service_segments seg
      WHERE seg.booking_id = v_booking_id AND seg.reservation_status <> 'cancelled') THEN
    RAISE EXCEPTION 'segment status did not synchronize';
  END IF;
END;
$sequence_behavior$;

SET CONSTRAINTS ALL IMMEDIATE;

DO $sequence_tamper_proof$
DECLARE
  v_booking_id uuid;
  v_segment_id uuid;
BEGIN
  SELECT b.id INTO STRICT v_booking_id FROM public.bookings b
  WHERE b.idempotency_key = '40000000-0000-4000-8000-000000000001';
  SELECT seg.id INTO STRICT v_segment_id FROM public.booking_service_segments seg
  WHERE seg.booking_id = v_booking_id ORDER BY seg.position LIMIT 1;
  BEGIN
    UPDATE public.booking_service_segments
    SET customer_start_utc = customer_start_utc + interval '1 minute'
    WHERE id = v_segment_id;
    RAISE EXCEPTION 'segment schedule tamper unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation
    OR object_not_in_prerequisite_state OR raise_exception THEN
    IF SQLERRM = 'segment schedule tamper unexpectedly succeeded' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.bookings
    SET start_time_utc = start_time_utc + interval '1 minute'
    WHERE id = v_booking_id;
    RAISE EXCEPTION 'sequence parent-only move unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation
    OR object_not_in_prerequisite_state OR raise_exception THEN
    IF SQLERRM = 'sequence parent-only move unexpectedly succeeded' THEN RAISE; END IF;
  END;
END;
$sequence_tamper_proof$;

ROLLBACK;
