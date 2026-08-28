\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.service_categories(slug, name_en, name_vi)
VALUES ('booking-otp-truth-qa-20260828', 'Booking OTP truth QA', 'Booking OTP truth QA')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.salons(id, slug, name, phone, timezone)
VALUES (
  'e93d0000-0000-4000-8000-000000000001',
  'booking-otp-truth-qa-20260828',
  'Booking OTP Truth QA',
  '+16045550990',
  'America/Vancouver'
);

DO $behavior$
DECLARE
  v_salon uuid := 'e93d0000-0000-4000-8000-000000000001';
  v_sms_fingerprint text := encode(extensions.digest(
    pg_catalog.convert_to('+16045550991', 'UTF8'), 'sha256'
  ), 'hex');
  v_email_fingerprint text := encode(extensions.digest(
    pg_catalog.convert_to('otp@example.invalid', 'UTF8'), 'sha256'
  ), 'hex');
  v_sms uuid;
  v_email uuid;
  v_marked uuid;
  v_result jsonb;
BEGIN
  v_sms := public.create_booking_otp_delivery_attempt(
    v_salon, 'sms', v_sms_fingerprint
  );
  IF v_sms IS NULL THEN RAISE EXCEPTION 'SMS attempt claim failed'; END IF;

  v_result := public.complete_booking_otp_delivery_attempt(
    v_sms, 'provider_accepted',
    'VEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'VLbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    NULL
  );
  IF v_result->>'code' <> 'completed'
     OR NOT EXISTS (
       SELECT 1 FROM public.booking_otp_delivery_attempts a
       WHERE a.id = v_sms
         AND a.status = 'provider_accepted'
         AND a.provider_name = 'twilio_verify'
         AND a.accepted_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'SMS provider acceptance failed: %', v_result;
  END IF;

  v_marked := public.mark_booking_otp_delivery_verified(
    v_salon, 'sms', v_sms_fingerprint, v_sms
  );
  IF v_marked <> v_sms OR NOT EXISTS (
       SELECT 1 FROM public.booking_otp_delivery_attempts a
       WHERE a.id = v_sms AND a.status = 'delivered'
         AND a.delivered_at IS NOT NULL AND a.verified_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'customer-entered SMS proof was not recorded';
  END IF;

  -- A late transport failure cannot erase stronger direct customer proof.
  v_result := public.complete_booking_otp_delivery_attempt(
    v_sms, 'failed',
    'VEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'VLbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'late_provider_failure'
  );
  IF v_result->>'code' <> 'stronger_state_preserved'
     OR (SELECT status FROM public.booking_otp_delivery_attempts WHERE id = v_sms)
       <> 'delivered' THEN
    RAISE EXCEPTION 'stronger verified state was downgraded: %', v_result;
  END IF;

  v_email := public.create_booking_otp_delivery_attempt(
    v_salon, 'email', v_email_fingerprint
  );
  IF v_email IS NULL THEN RAISE EXCEPTION 'email attempt claim failed'; END IF;

  INSERT INTO public.email_otp_codes(
    salon_id, phone, email, code_hash, expires_at, delivery_attempt_id
  ) VALUES (
    v_salon, '16045550991', 'otp@example.invalid', repeat('f', 64),
    transaction_timestamp() + interval '10 minutes', v_email
  );

  v_result := public.complete_booking_otp_delivery_attempt(
    v_email, 'provider_accepted', 'resend-booking-otp-message', NULL, NULL
  );
  IF v_result->>'code' <> 'completed' THEN
    RAISE EXCEPTION 'email provider acceptance failed: %', v_result;
  END IF;

  v_result := public.record_resend_booking_otp_delivery_event(
    v_email,
    'evt-booking-otp-delivered',
    'resend-booking-otp-message',
    'email.delivered',
    v_email_fingerprint,
    transaction_timestamp() - interval '1 second',
    repeat('a', 64)
  );
  IF v_result->>'code' <> 'event_applied'
     OR NOT EXISTS (
       SELECT 1 FROM public.booking_otp_delivery_attempts a
       WHERE a.id = v_email AND a.status = 'delivered'
         AND a.delivered_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'signed email delivery receipt failed: %', v_result;
  END IF;

  v_result := public.record_resend_booking_otp_delivery_event(
    v_email,
    'evt-booking-otp-delivered',
    'resend-booking-otp-message',
    'email.delivered',
    v_email_fingerprint,
    transaction_timestamp() - interval '1 second',
    repeat('a', 64)
  );
  IF v_result->>'code' <> 'event_replay'
     OR (SELECT count(*) FROM public.resend_booking_otp_delivery_events
         WHERE provider_event_id = 'evt-booking-otp-delivered') <> 1 THEN
    RAISE EXCEPTION 'exact receipt replay was not idempotent: %', v_result;
  END IF;

  v_result := public.record_resend_booking_otp_delivery_event(
    v_email,
    'evt-booking-otp-delivered',
    'resend-booking-otp-message',
    'email.delivered',
    v_email_fingerprint,
    transaction_timestamp() - interval '1 second',
    repeat('b', 64)
  );
  IF v_result->>'code' <> 'event_conflict' THEN
    RAISE EXCEPTION 'changed receipt replay did not conflict: %', v_result;
  END IF;

  IF public.create_booking_otp_delivery_attempt(v_salon, 'sms', 'not-a-hash')
       IS NOT NULL THEN
    RAISE EXCEPTION 'invalid recipient fingerprint was accepted';
  END IF;
END;
$behavior$;

DO $boundary$
BEGIN
  IF has_table_privilege(
       'anon', 'public.booking_otp_delivery_attempts', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'authenticated', 'public.booking_otp_delivery_attempts', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'service_role', 'public.booking_otp_delivery_attempts', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'anon', 'public.resend_booking_otp_delivery_events', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'authenticated', 'public.resend_booking_otp_delivery_events', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'service_role', 'public.resend_booking_otp_delivery_events', 'SELECT,INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'OTP delivery truth tables became directly reachable';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.create_booking_otp_delivery_attempt(uuid,text,text)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.create_booking_otp_delivery_attempt(uuid,text,text)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.create_booking_otp_delivery_attempt(uuid,text,text)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.complete_booking_otp_delivery_attempt(uuid,text,text,text,text)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.mark_booking_otp_delivery_verified(uuid,text,text,uuid)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.record_resend_booking_otp_delivery_event(uuid,text,text,text,text,timestamptz,text)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'OTP delivery truth RPC ACL mismatch';
  END IF;
END;
$boundary$;

ROLLBACK;
