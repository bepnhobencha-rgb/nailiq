-- Disposable QA only. Synthetic atomic-create and committed-replay proof; all rolled back.
-- Provider notifications, SMS/email/call and charge dispatch must be OFF in the runner.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
CREATE TEMPORARY TABLE qa_otp_flow_results(flow text, channel text, passed boolean) ON COMMIT DROP;
DO $qa$
DECLARE
  s uuid := extensions.gen_random_uuid();
  sv uuid := extensions.gen_random_uuid();
  sv2 uuid := extensions.gen_random_uuid();
  st uuid := extensions.gen_random_uuid();
  st2 uuid := extensions.gen_random_uuid();
  otp uuid; req uuid; b uuid; channel text; flow text; v_phone text;
  payload jsonb; lines jsonb; q jsonb; r jsonb; replay jsonb; before_count integer; idx integer := 0;
  start_at timestamptz; profile_before timestamptz; profile_after timestamptz;
BEGIN
  INSERT INTO public.service_categories(slug, name_en, name_vi)
  VALUES('qa-otp-flow-' || s, 'Synthetic OTP Flow', 'Synthetic OTP Flow');
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code, profile_complete,
    subscription_plan, subscription_status, is_beta, resources_enabled, phone_otp_enabled, opening_hours, feature_flags, tax_lines)
  VALUES(s, 'disposable-otp-flow-' || s, 'Synthetic OTP Flow', '', 'UTC', 'CAD', true,
    'premium', 'active', true, false, true,
    '{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}',
    '{"group_booking_enabled":true,"group_multi_service_booking_enabled":true}',
    '[{"name":"GST","rate":0.05,"enabled":true}]');
  INSERT INTO public.services(id, salon_id, name, price_cents, duration_minutes, buffer_minutes, prep_minutes, is_addon, addon_timing, category)
  VALUES(sv, s, 'Synthetic OTP Service One', 2000, 30, 0, 0, false, 'sequential', 'qa-otp-flow-' || s),
    (sv2, s, 'Synthetic OTP Service Two', 1000, 20, 0, 0, false, 'sequential', 'qa-otp-flow-' || s);
  INSERT INTO public.staff(id, salon_id, name, status)
  VALUES(st, s, 'Synthetic OTP Staff One', 'active'), (st2, s, 'Synthetic OTP Staff Two', 'active');
  INSERT INTO public.platform_flags(key, enabled, description)
  VALUES('feature_multi_service_booking', true, 'disposable OTP proof'),
    ('feature_group_multi_service_booking', true, 'disposable OTP proof')
  ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled;
  r := public.configure_multi_service_booking_qa_salon(s, true, 'ENABLE_MULTI_SERVICE_QA');
  IF r->>'code' IS DISTINCT FROM 'enabled' THEN RAISE EXCEPTION 'FAIL disposable flow configuration: %', r->>'code'; END IF;

  FOREACH flow IN ARRAY ARRAY['sequence', 'group_sequence'] LOOP
    FOREACH channel IN ARRAY ARRAY['email', 'sms', 'legacy_unverified'] LOOP
      idx := idx + 1;
      v_phone := '1604555018' || idx;
      start_at := date_trunc('day', now() + interval '8 days') + idx * interval '2 hours';
      req := extensions.gen_random_uuid();
      INSERT INTO public.phone_otp_sessions(phone, salon_id, verified_channel)
      VALUES(v_phone, s, channel) RETURNING id INTO otp;
      lines := jsonb_build_array(
        jsonb_build_object('line_id', extensions.gen_random_uuid(), 'position', 0, 'service_id', sv,
          'staff_preference', st, 'preferred_resource_id', null, 'addon_service_ids', '[]'::jsonb),
        jsonb_build_object('line_id', extensions.gen_random_uuid(), 'position', 1, 'service_id', sv2,
          'staff_preference', st, 'preferred_resource_id', null, 'addon_service_ids', '[]'::jsonb));
      IF flow = 'sequence' THEN
        payload := jsonb_build_object('contract_version', 1, 'salon_id', s, 'request_id', req,
          'requested_start_time_utc', start_at, 'same_staff_for_all', true, 'voucher_code', null,
          'apply_email_discount', false, 'customer', jsonb_build_object('name', 'Synthetic OTP Customer', 'phone', v_phone, 'email', 'synthetic@example.test'), 'lines', lines);
        q := public.quote_public_booking_sequence(payload);
      ELSE
        payload := jsonb_build_object('contract_version', 1, 'salon_id', s, 'group_request_id', req,
          'requested_anchor_utc', start_at, 'seat_together', false, 'apply_email_discount', false,
          'organizer', jsonb_build_object('name', 'Synthetic OTP Customer', 'phone', v_phone, 'email', 'synthetic@example.test'),
          'members', jsonb_build_array(
            jsonb_build_object('member_index', 0, 'member_request_id', extensions.gen_random_uuid(),
              'requested_start_time_utc', start_at, 'same_staff_for_all', true,
              'customer', jsonb_build_object('name', 'Synthetic OTP Customer', 'phone', v_phone, 'email', 'synthetic@example.test'), 'lines', lines),
            jsonb_build_object('member_index', 1, 'member_request_id', extensions.gen_random_uuid(),
              'requested_start_time_utc', start_at, 'same_staff_for_all', false,
              'customer', jsonb_build_object('name', 'Synthetic Guest', 'phone', '', 'email', null),
              'lines', jsonb_build_array(jsonb_build_object('line_id', extensions.gen_random_uuid(), 'position', 0,
                'service_id', sv, 'staff_preference', st2, 'preferred_resource_id', null, 'addon_service_ids', '[]'::jsonb)))));
        q := public.quote_public_group_booking_sequences(payload);
      END IF;
      IF q->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FAIL % quote: %', flow, q->>'code'; END IF;
      payload := payload || jsonb_build_object('expected_pricing_fingerprint', q->>'pricing_fingerprint',
        'otp_session_id', otp, 'health_acknowledged', false, 'sms_consent', false, 'notification_language', 'vi');
      SELECT count(*) INTO before_count FROM public.bookings WHERE salon_id = s;
      SELECT phone_verified_at INTO profile_before FROM public.client_profiles WHERE client_profiles.phone = v_phone;
      IF flow = 'sequence' THEN r := public.create_public_booking_sequence(payload);
      ELSE r := public.create_public_group_booking_sequences(payload); END IF;
      IF channel = 'legacy_unverified' THEN
        IF r->>'code' IS DISTINCT FROM 'invalid_otp_session'
          OR (SELECT count(*) FROM public.bookings WHERE salon_id = s) <> before_count
          OR (SELECT consumed_at FROM public.phone_otp_sessions WHERE id = otp) IS NOT NULL THEN
          RAISE EXCEPTION 'FAIL legacy % created business rows: %', flow, r->>'code';
        END IF;
      ELSE
        IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'FAIL % % create: %', flow, channel, r->>'code'; END IF;
        SELECT consumed_by_booking_id INTO b FROM public.phone_otp_sessions WHERE id = otp;
        IF b IS NULL OR NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = b AND otp_session_id = otp) THEN
          RAISE EXCEPTION 'FAIL % consumption binding', flow;
        END IF;
        SELECT phone_verified_at INTO profile_after FROM public.client_profiles WHERE client_profiles.phone = v_phone;
        IF (channel = 'email' AND profile_after IS DISTINCT FROM profile_before)
          OR (channel = 'sms' AND profile_after IS NULL) THEN RAISE EXCEPTION 'FAIL % profile proof: %', flow, channel; END IF;
        IF flow = 'sequence' THEN replay := public.create_public_booking_sequence(payload);
        ELSE replay := public.create_public_group_booking_sequences(payload); END IF;
        IF replay->>'success' IS DISTINCT FROM 'true' OR replay->>'idempotent' IS DISTINCT FROM 'true'
          OR (SELECT count(*) FROM public.bookings WHERE salon_id = s) <> before_count + (CASE WHEN flow = 'sequence' THEN 1 ELSE 2 END) THEN
          RAISE EXCEPTION 'FAIL % committed replay duplicated or lost', flow;
        END IF;
      END IF;
      INSERT INTO qa_otp_flow_results VALUES(flow, channel, true);
    END LOOP;
  END LOOP;
END;
$qa$;
SELECT * FROM qa_otp_flow_results;
ROLLBACK;
