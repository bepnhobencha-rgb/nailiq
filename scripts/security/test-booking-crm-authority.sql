-- R09 regression acceptance. Offline disposable QA only, synthetic data.
-- Run after both R09 migrations; all changes roll back. No outbound/provider actions.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
CREATE TEMPORARY TABLE qa_r09_crm_results(
  scenario text, booking_created boolean, profile_email_unchanged boolean,
  preferred_staff_unchanged boolean, visit_count_before integer, visit_count_after integer,
  last_service_unchanged boolean, global_consent_unchanged boolean,
  phone_proof_unchanged boolean, replay_did_not_increment boolean
) ON COMMIT DROP;
CREATE FUNCTION pg_temp.reject_synthetic_sequence_insert() RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
  RAISE EXCEPTION 'synthetic post-resolver insert failure' USING ERRCODE='23514';
END;$trigger$;
CREATE TRIGGER qa_r09_fail_sequence_insert BEFORE INSERT ON public.bookings
  FOR EACH ROW WHEN(NEW.client_name='Synthetic Force CRM Rollback') EXECUTE FUNCTION pg_temp.reject_synthetic_sequence_insert();
DO $repro$
DECLARE
  s uuid := extensions.gen_random_uuid();
  sv uuid := extensions.gen_random_uuid(); sv2 uuid := extensions.gen_random_uuid();
  st_old uuid := extensions.gen_random_uuid(); st uuid := extensions.gen_random_uuid(); st2 uuid := extensions.gen_random_uuid();
  profile_id uuid; otp uuid; req uuid; b uuid; scenario text; v_phone text; organizer_phone text;
  payload jsonb; lines jsonb; q jsonb; r jsonb; replay jsonb;
  cp_before public.client_profiles%ROWTYPE; cp_after public.client_profiles%ROWTYPE;
  idx integer := 0; start_at timestamptz;
BEGIN
  INSERT INTO public.service_categories(slug, name_en, name_vi)
  VALUES('qa-r08-' || s, 'Synthetic R08', 'Synthetic R08');
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code, profile_complete,
    subscription_plan, subscription_status, is_beta, resources_enabled, phone_otp_enabled, opening_hours, feature_flags, tax_lines)
  VALUES(s, 'disposable-r08-' || s, 'Synthetic R08 CRM', '', 'UTC', 'CAD', true,
    'premium', 'active', true, false, true,
    '{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}',
    '{"group_booking_enabled":true,"group_multi_service_booking_enabled":true}',
    '[{"name":"GST","rate":0.05,"enabled":true}]');
  INSERT INTO public.services(id, salon_id, name, price_cents, duration_minutes, buffer_minutes, prep_minutes, is_addon, addon_timing, category)
  VALUES(sv, s, 'Synthetic R08 Service One', 2000, 30, 0, 0, false, 'sequential', 'qa-r08-' || s),
    (sv2, s, 'Synthetic R08 Service Two', 1000, 20, 0, 0, false, 'sequential', 'qa-r08-' || s);
  INSERT INTO public.staff(id, salon_id, name, status)
  VALUES(st_old, s, 'Synthetic Existing Preference', 'active'),
    (st, s, 'Synthetic Claimed Preference', 'active'), (st2, s, 'Synthetic Guest Preference', 'active');
  INSERT INTO public.platform_flags(key, enabled, description)
  VALUES('feature_multi_service_booking', true, 'disposable R08 repro'),
    ('feature_group_multi_service_booking', true, 'disposable R08 repro')
  ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled;
  r := public.configure_multi_service_booking_qa_salon(s, true, 'ENABLE_MULTI_SERVICE_QA');
  IF r->>'code' IS DISTINCT FROM 'enabled' THEN RAISE EXCEPTION 'fixture configuration failed: %', r->>'code'; END IF;

  FOREACH scenario IN ARRAY ARRAY['individual_unverified', 'sequence_email', 'legacy_group_email', 'group_sequence_email', 'group_sequence_sms_guest', 'sequence_sms_failed'] LOOP
    idx := idx + 1;
    v_phone := '1703555017' || idx;
    organizer_phone := CASE WHEN scenario = 'group_sequence_sms_guest' THEN '17035550185' ELSE v_phone END;
    profile_id := extensions.gen_random_uuid(); otp := NULL; req := extensions.gen_random_uuid();
    start_at := date_trunc('day', now() + interval '8 days') + idx * interval '2 hours';
    INSERT INTO public.client_profiles(id, phone, name, email, preferred_staff_id, visit_count, last_service_date,
      phone_verified_at, marketing_consent_at, marketing_email_consent_at, is_vip)
    VALUES(profile_id, v_phone, 'Synthetic Existing Customer', NULL, st_old, 7, now() - interval '90 days',
      now() - interval '100 days', now() - interval '80 days', now() - interval '80 days', true);
    SELECT * INTO cp_before FROM public.client_profiles WHERE id = profile_id;
    IF scenario <> 'individual_unverified' THEN
      INSERT INTO public.phone_otp_sessions(phone, salon_id, verified_channel)
      VALUES(organizer_phone, s, CASE WHEN scenario IN ('group_sequence_sms_guest','sequence_sms_failed') THEN 'sms' ELSE 'email' END)
      RETURNING id INTO otp;
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('line_id', extensions.gen_random_uuid(), 'position', 0, 'service_id', sv,
        'staff_preference', st, 'preferred_resource_id', null, 'addon_service_ids', '[]'::jsonb),
      jsonb_build_object('line_id', extensions.gen_random_uuid(), 'position', 1, 'service_id', sv2,
        'staff_preference', st, 'preferred_resource_id', null, 'addon_service_ids', '[]'::jsonb));

    IF scenario = 'individual_unverified' THEN
      q := public.resolve_public_booking_pricing(s, sv, st, start_at, start_at + interval '30 minutes',
        ARRAY[]::uuid[], NULL, NULL, v_phone, 'qa-claimed@example.test', false, true);
    ELSIF scenario IN ('sequence_email','sequence_sms_failed') THEN
      payload := jsonb_build_object('contract_version', 1, 'salon_id', s, 'request_id', req,
        'requested_start_time_utc', start_at, 'same_staff_for_all', true, 'voucher_code', null,
        'apply_email_discount', false, 'customer', jsonb_build_object('name', CASE WHEN scenario='sequence_sms_failed' THEN 'Synthetic Force CRM Rollback' ELSE 'Synthetic Claimed Contact' END, 'phone', v_phone, 'email', 'qa-claimed@example.test'), 'lines', lines);
      payload := payload || jsonb_build_object('otp_session_id',otp);
      q := public.quote_public_booking_sequence(payload);
    ELSIF scenario = 'legacy_group_email' THEN
      payload := jsonb_build_array(
        jsonb_build_object('service_id', sv, 'staff_id', st, 'start_time_utc', start_at, 'end_time_utc', start_at + interval '30 minutes',
          'addon_service_ids', '[]'::jsonb, 'client_name', 'Synthetic Claimed Contact', 'client_phone', v_phone, 'client_email', 'qa-claimed@example.test', 'staff_requested_by_client', true, 'wave_number', 1, 'seat_together', false, 'client_locale', 'vi'),
        jsonb_build_object('service_id', sv, 'staff_id', st2, 'start_time_utc', start_at, 'end_time_utc', start_at + interval '30 minutes',
          'addon_service_ids', '[]'::jsonb, 'client_name', 'Synthetic Guest', 'client_phone', null, 'staff_requested_by_client', true, 'wave_number', 1, 'seat_together', false, 'client_locale', 'vi'));
      q := public.quote_group_booking(s, payload, NULL, v_phone, 'qa-claimed@example.test', false);
    ELSE
      payload := jsonb_build_object('contract_version', 1, 'salon_id', s, 'group_request_id', req,
        'requested_anchor_utc', start_at, 'seat_together', false, 'apply_email_discount', false,
        'organizer', jsonb_build_object('name', 'Synthetic Claimed Contact', 'phone', organizer_phone, 'email', 'qa-claimed@example.test'),
        'members', jsonb_build_array(
          jsonb_build_object('member_index', 0, 'member_request_id', extensions.gen_random_uuid(), 'requested_start_time_utc', start_at, 'same_staff_for_all', true,
            'customer', jsonb_build_object('name', 'Synthetic Claimed Contact', 'phone', organizer_phone, 'email', 'qa-claimed@example.test'), 'lines', lines),
          jsonb_build_object('member_index', 1, 'member_request_id', extensions.gen_random_uuid(), 'requested_start_time_utc', start_at, 'same_staff_for_all', false,
            'customer', jsonb_build_object('name', 'Synthetic Guest', 'phone', CASE WHEN scenario = 'group_sequence_sms_guest' THEN v_phone ELSE '' END, 'email', 'qa-claimed@example.test'),
            'lines', jsonb_build_array(jsonb_build_object('line_id', extensions.gen_random_uuid(), 'position', 0, 'service_id', sv,
              'staff_preference', st2, 'preferred_resource_id', null, 'addon_service_ids', '[]'::jsonb)))));
      payload := payload || jsonb_build_object('otp_session_id',otp);
      q := public.quote_public_group_booking_sequences(payload);
    END IF;
    IF q->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fixture % quote failed: %', scenario, q->>'code'; END IF;

    IF scenario = 'individual_unverified' THEN
      r := public.create_public_booking(s, sv, st, 'Synthetic Claimed Contact', v_phone, start_at, start_at + interval '30 minutes',
        'confirmed', NULL, ARRAY[]::uuid[], 'qa-claimed@example.test', NULL, NULL, NULL, false, req, q->>'pricing_fingerprint');
    ELSIF scenario = 'legacy_group_email' THEN
      IF NOT public.validate_booking_otp_session(otp, s, v_phone) THEN RAISE EXCEPTION 'fixture email gate rejected'; END IF;
      r := public.create_group_bookings(s, payload, NULL, v_phone, 'qa-claimed@example.test', false, req, q->>'pricing_fingerprint');
    ELSE
      payload := payload || jsonb_build_object('expected_pricing_fingerprint', q->>'pricing_fingerprint',
        'otp_session_id', otp, 'health_acknowledged', false, 'sms_consent', false, 'notification_language', 'vi');
      IF scenario IN ('sequence_email','sequence_sms_failed') THEN r := public.create_public_booking_sequence(payload);
      ELSE r := public.create_public_group_booking_sequences(payload); END IF;
    END IF;
    IF scenario='sequence_sms_failed' THEN
      IF r->>'success' IS DISTINCT FROM 'false'
        OR (SELECT to_jsonb(p) FROM public.client_profiles p WHERE id=profile_id) IS DISTINCT FROM to_jsonb(cp_before)
        OR EXISTS(SELECT 1 FROM public.phone_otp_sessions WHERE id=otp AND consumed_at IS NOT NULL)
        OR EXISTS(SELECT 1 FROM public.bookings WHERE salon_id=s AND idempotency_key=req) THEN
        RAISE EXCEPTION 'sequence insert failure retained CRM/OTP mutation';
      END IF;
      INSERT INTO qa_r09_crm_results VALUES(scenario,false,true,true,cp_before.visit_count,cp_before.visit_count,true,true,true,true);
      CONTINUE;
    END IF;
    IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fixture % create failed: %', scenario, r->>'code'; END IF;
    SELECT * INTO cp_after FROM public.client_profiles WHERE id = profile_id;
    IF to_jsonb(cp_after) IS DISTINCT FROM to_jsonb(cp_before) THEN
      RAISE EXCEPTION 'unproved contact mutated global CRM: %', scenario;
    END IF;
    b := coalesce(nullif(r->>'booking_id',''),r->'booking_ids'->>0)::uuid;
    IF scenario <> 'group_sequence_sms_guest' AND NOT EXISTS(
      SELECT 1 FROM public.bookings WHERE id=b AND client_profile_id IS NULL AND is_party_member IS FALSE
    ) THEN RAISE EXCEPTION 'unproved named organizer not normal unlinked booking: %',scenario; END IF;
    IF scenario = 'group_sequence_sms_guest' AND EXISTS(
      SELECT 1 FROM public.bookings WHERE id=ANY(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(r->'booking_ids')))
        AND public.canonical_phone(client_phone)=public.canonical_phone(v_phone) AND client_profile_id IS NOT NULL
    ) THEN RAISE EXCEPTION 'organizer SMS linked guest phone'; END IF;

    IF scenario = 'individual_unverified' THEN
      replay := public.create_public_booking(s, sv, st, 'Synthetic Claimed Contact', v_phone, start_at, start_at + interval '30 minutes',
        'confirmed', NULL, ARRAY[]::uuid[], 'qa-claimed@example.test', NULL, NULL, NULL, false, req, q->>'pricing_fingerprint');
    ELSIF scenario = 'legacy_group_email' THEN
      replay := public.create_group_bookings(s, payload, NULL, v_phone, 'qa-claimed@example.test', false, req, q->>'pricing_fingerprint');
    ELSIF scenario IN ('sequence_email','sequence_sms_failed') THEN replay := public.create_public_booking_sequence(payload);
    ELSE replay := public.create_public_group_booking_sequences(payload); END IF;
    IF replay->>'success' IS DISTINCT FROM 'true' OR replay->>'idempotent' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'fixture replay failed: %', scenario;
    END IF;
    INSERT INTO qa_r09_crm_results VALUES(scenario, true,
      cp_after.email IS NOT DISTINCT FROM cp_before.email,
      cp_after.preferred_staff_id IS NOT DISTINCT FROM cp_before.preferred_staff_id,
      cp_before.visit_count, cp_after.visit_count,
      cp_after.last_service_date IS NOT DISTINCT FROM cp_before.last_service_date,
      cp_after.marketing_consent_at IS NOT DISTINCT FROM cp_before.marketing_consent_at
        AND cp_after.marketing_email_consent_at IS NOT DISTINCT FROM cp_before.marketing_email_consent_at,
      cp_after.phone_verified_at IS NOT DISTINCT FROM cp_before.phone_verified_at,
      (SELECT visit_count FROM public.client_profiles WHERE id = profile_id) = cp_after.visit_count);
  END LOOP;
END;
$repro$;
SELECT * FROM qa_r09_crm_results;
ROLLBACK;
