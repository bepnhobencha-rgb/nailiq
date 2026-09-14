-- Disposable QA only; provider notifications, SMS/email/call and charges OFF.
-- Entire synthetic fixture and every write roll back. No provider calls here.
BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
CREATE TEMPORARY TABLE qa_otp_authority_results(scenario text, passed boolean) ON COMMIT DROP;
DO $qa$
DECLARE
  s uuid := extensions.gen_random_uuid();
  other_s uuid := extensions.gen_random_uuid();
  sv uuid := extensions.gen_random_uuid();
  st uuid := extensions.gen_random_uuid();
  profile_id uuid := extensions.gen_random_uuid();
  phone text := '16045550191';
  otp uuid; b uuid; other_b uuid; channel text; r jsonb; idx integer := 0;
  frozen_verified_at timestamptz; frozen_marketing_at timestamptz; consumed timestamptz;
BEGIN
  INSERT INTO public.service_categories(slug, name_en, name_vi)
  VALUES('qa-otp-' || s, 'Synthetic OTP', 'Synthetic OTP');
  INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code, profile_complete)
  VALUES(s, 'qa-otp-' || s, 'Synthetic OTP Authority', '', 'America/Vancouver', 'CAD', true),
    (other_s, 'qa-otp-' || other_s, 'Synthetic Foreign OTP', '', 'America/Vancouver', 'CAD', true);
  INSERT INTO public.services(id, salon_id, name, price_cents, duration_minutes, category)
  VALUES(sv, s, 'Synthetic OTP Service', 5000, 30, 'qa-otp-' || s);
  INSERT INTO public.staff(id, salon_id, name, status) VALUES(st, s, 'Synthetic OTP Staff', 'active');
  INSERT INTO public.client_profiles(id, phone, name, email, visit_count, is_vip)
  VALUES(profile_id, phone, 'Synthetic Existing Customer', 'existing-customer@example.test', 7, true);

  INSERT INTO public.phone_otp_sessions(phone, salon_id) VALUES(phone, s) RETURNING id INTO otp;
  IF (SELECT verified_channel FROM public.phone_otp_sessions WHERE id = otp) <> 'legacy_unverified'
    OR public.validate_phone_otp_session(otp, s, phone)
    OR public.validate_booking_otp_session(otp, s, phone) THEN
    RAISE EXCEPTION 'FAIL historical/omitted proof must stay untrusted';
  END IF;
  BEGIN
    INSERT INTO public.phone_otp_sessions(phone, salon_id, verified_channel) VALUES(phone, s, 'claimed_sms');
    RAISE EXCEPTION 'FAIL invented channel accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO qa_otp_authority_results VALUES('legacy default and invalid channel fail closed', true);

  FOREACH channel IN ARRAY ARRAY['email', 'staff_attested', 'demo', 'legacy_unverified', 'sms'] LOOP
    idx := idx + 1;
    INSERT INTO public.phone_otp_sessions(phone, salon_id, verified_channel)
    VALUES(phone, s, channel) RETURNING id INTO otp;
    IF public.validate_booking_otp_session(otp, s, phone) IS DISTINCT FROM (channel <> 'legacy_unverified')
      OR public.validate_phone_otp_session(otp, s, phone) IS DISTINCT FROM (channel = 'sms') THEN
      RAISE EXCEPTION 'FAIL channel authority: %', channel;
    END IF;
    IF public.validate_booking_otp_session(otp, other_s, phone)
      OR public.validate_phone_otp_session(otp, other_s, phone)
      OR public.validate_booking_otp_session(otp, s, '16045550192')
      OR public.validate_phone_otp_session(otp, s, '16045550192')
      OR public.validate_booking_otp_session(extensions.gen_random_uuid(), s, phone) THEN
      RAISE EXCEPTION 'FAIL tuple isolation: %', channel;
    END IF;

    UPDATE public.phone_otp_sessions SET expires_at = now() - interval '1 second' WHERE id = otp;
    IF public.validate_booking_otp_session(otp, s, phone) OR public.validate_phone_otp_session(otp, s, phone) THEN
      RAISE EXCEPTION 'FAIL expired channel: %', channel;
    END IF;
    UPDATE public.phone_otp_sessions SET expires_at = now() + interval '15 minutes' WHERE id = otp;

    INSERT INTO public.bookings(salon_id, service_id, staff_id, client_name, client_phone, client_email,
      client_profile_id, start_time_utc, end_time_utc, status, price_cents)
    VALUES(s, sv, st, 'Synthetic Claimed Contact', phone, 'outsider@example.test', profile_id,
      now() + interval '10 days' + idx * interval '2 hours',
      now() + interval '10 days' + idx * interval '2 hours' + interval '30 minutes', 'confirmed', 5000)
    RETURNING id INTO b;
    IF EXISTS (SELECT 1 FROM public.get_booking_client_snapshot(s, phone, b)) THEN
      RAISE EXCEPTION 'FAIL booking capability alone exposed CRM history: %', channel;
    END IF;
    SELECT phone_verified_at, marketing_consent_at INTO frozen_verified_at, frozen_marketing_at
    FROM public.client_profiles WHERE id = profile_id;

    IF channel <> 'sms' THEN
      r := public.confirm_booking_with_otp(b, otp);
      IF r->>'ok' IS DISTINCT FROM 'false' OR
        (SELECT consumed_at FROM public.phone_otp_sessions WHERE id = otp) IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL non-SMS legacy confirmation: %', channel;
      END IF;
    END IF;

    r := public.finalize_public_booking_profile(b, otp, true);
    IF channel = 'legacy_unverified' THEN
      IF r->>'code' IS DISTINCT FROM 'invalid_otp_session' OR
        (SELECT consumed_at FROM public.phone_otp_sessions WHERE id = otp) IS NOT NULL THEN
        RAISE EXCEPTION 'FAIL legacy finalization';
      END IF;
    ELSE
      IF r->>'success' IS DISTINCT FROM 'true'
        OR r->>'otp_stamped' IS DISTINCT FROM 'true'
        OR (r->>'marketing_consent_stamped')::boolean IS DISTINCT FROM (channel = 'sms')
        OR NOT EXISTS (SELECT 1 FROM public.phone_otp_sessions WHERE id = otp
          AND consumed_at IS NOT NULL AND consumed_by_booking_id = b)
        OR NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = b AND otp_session_id = otp)
        OR public.validate_booking_otp_session(otp, s, phone)
        OR public.validate_phone_otp_session(otp, s, phone) THEN
        RAISE EXCEPTION 'FAIL finalization/consumption: %', channel;
      END IF;
      SELECT consumed_at INTO consumed FROM public.phone_otp_sessions WHERE id = otp;
      IF public.finalize_public_booking_profile(b, otp, true)->>'success' IS DISTINCT FROM 'true'
        OR (SELECT consumed_at FROM public.phone_otp_sessions WHERE id = otp) IS DISTINCT FROM consumed THEN
        RAISE EXCEPTION 'FAIL exact replay: %', channel;
      END IF;

      -- A copied booking.otp_session_id is insufficient to reuse consumed proof.
      INSERT INTO public.bookings(salon_id, service_id, staff_id, client_name, client_phone, client_profile_id,
        start_time_utc, end_time_utc, status, price_cents, otp_session_id)
      VALUES(s, sv, st, 'Synthetic Other Booking', phone, profile_id,
        now() + interval '20 days' + idx * interval '2 hours',
        now() + interval '20 days' + idx * interval '2 hours' + interval '30 minutes', 'confirmed', 5000, otp)
      RETURNING id INTO other_b;
      IF public.finalize_public_booking_profile(other_b, otp, true)->>'code' IS DISTINCT FROM 'invalid_otp_session'
        OR (SELECT consumed_by_booking_id FROM public.phone_otp_sessions WHERE id = otp) IS DISTINCT FROM b THEN
        RAISE EXCEPTION 'FAIL consumed proof rebound: %', channel;
      END IF;
    END IF;

    IF channel = 'sms' THEN
      IF NOT EXISTS (SELECT 1 FROM public.get_booking_client_snapshot(s, phone, b)
        WHERE visit_count = 7 AND is_vip IS TRUE AND name = 'Synthetic Existing Customer') THEN
        RAISE EXCEPTION 'FAIL exact SMS snapshot unavailable';
      END IF;
      IF EXISTS (SELECT 1 FROM public.get_booking_client_snapshot(other_s, phone, b))
        OR EXISTS (SELECT 1 FROM public.get_booking_client_snapshot(s, '16045550192', b))
        OR EXISTS (SELECT 1 FROM public.get_booking_client_snapshot(s, phone, other_b)) THEN
        RAISE EXCEPTION 'FAIL snapshot tuple/consumption isolation';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM public.get_booking_client_snapshot(s, phone, b)) THEN
      RAISE EXCEPTION 'FAIL non-SMS booking exposed CRM history: %', channel;
    END IF;

    IF channel <> 'sms' AND EXISTS (SELECT 1 FROM public.client_profiles WHERE id = profile_id AND
      (phone_verified_at IS DISTINCT FROM frozen_verified_at OR marketing_consent_at IS DISTINCT FROM frozen_marketing_at)) THEN
      RAISE EXCEPTION 'FAIL non-phone owner stamped profile evidence: %', channel;
    END IF;
    IF channel = 'sms' AND NOT EXISTS (SELECT 1 FROM public.client_profiles WHERE id = profile_id
      AND phone_verified_at IS NOT NULL AND marketing_consent_at IS NOT NULL) THEN
      RAISE EXCEPTION 'FAIL genuine SMS profile proof missing';
    END IF;
    INSERT INTO qa_otp_authority_results VALUES(channel || ': authority, tuple, expiry, finalization, replay and profile evidence', true);
  END LOOP;

  -- A foreign salon SMS cannot confirm a matching-phone booking.
  INSERT INTO public.phone_otp_sessions(phone, salon_id, verified_channel)
  VALUES(phone, other_s, 'sms') RETURNING id INTO otp;
  IF public.confirm_booking_with_otp(b, otp)->>'ok' IS DISTINCT FROM 'false'
    OR public.finalize_public_booking_profile(b, otp, true)->>'code' IS DISTINCT FROM 'invalid_otp_session' THEN
    RAISE EXCEPTION 'FAIL foreign salon confirmation';
  END IF;

  IF has_table_privilege('anon', 'public.phone_otp_sessions', 'select')
    OR has_table_privilege('authenticated', 'public.phone_otp_sessions', 'select')
    OR NOT has_function_privilege('anon', 'public.validate_booking_otp_session(uuid,uuid,text)', 'execute')
    OR has_function_privilege('authenticated', 'public.validate_booking_otp_session(uuid,uuid,text)', 'execute')
    OR NOT has_function_privilege('service_role', 'public.validate_booking_otp_session(uuid,uuid,text)', 'execute')
    OR has_function_privilege('anon', 'public.confirm_booking_with_otp(uuid,uuid)', 'execute') THEN
    RAISE EXCEPTION 'FAIL authority ACL';
  END IF;
  INSERT INTO qa_otp_authority_results VALUES('foreign salon and API grants', true);
END;
$qa$;
SELECT * FROM qa_otp_authority_results;
ROLLBACK;
