\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.service_categories (slug, name_en, name_vi)
VALUES ('retry-envelope-qa', 'Retry envelope QA', 'Retry envelope QA')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO public.salons (id, slug, name, phone, timezone)
VALUES
  ('c5100000-0000-4000-8000-000000000001', 'retry-envelope-qa', 'Retry Envelope QA', '+16045550100', 'UTC'),
  ('c5100000-0000-4000-8000-000000000002', 'retry-envelope-other', 'Retry Envelope Other', '+16045550101', 'UTC');
INSERT INTO public.services (id, salon_id, name, price_cents, duration_minutes, category)
VALUES ('c5100000-0000-4000-8000-000000000003',
  'c5100000-0000-4000-8000-000000000001', 'Retry service', 2500, 30, 'retry-envelope-qa');
INSERT INTO public.staff (id, salon_id, name, status)
VALUES ('c5100000-0000-4000-8000-000000000004',
  'c5100000-0000-4000-8000-000000000001', 'Retry staff', 'active');
INSERT INTO public.bookings (
  id, salon_id, service_id, staff_id, client_name, client_phone, client_email,
  start_time_utc, end_time_utc, status, price_cents, sms_consent_at, sms_consent_meta
)
SELECT
  ('c5100000-0000-4000-8000-' || lpad(gs::text, 12, '0'))::uuid,
  'c5100000-0000-4000-8000-000000000001',
  'c5100000-0000-4000-8000-000000000003',
  'c5100000-0000-4000-8000-000000000004',
  'Retry Guest ' || gs, '+16045550200', 'retry@example.test',
  transaction_timestamp() + interval '3 hours' + make_interval(hours => gs),
  transaction_timestamp() + interval '3 hours 30 minutes' + make_interval(hours => gs),
  'confirmed', 2500, transaction_timestamp(), '{"source":"qa"}'::jsonb
FROM generate_series(10, 18) gs;

DO $behavior$
DECLARE
  v_salon uuid := 'c5100000-0000-4000-8000-000000000001';
  v_other uuid := 'c5100000-0000-4000-8000-000000000002';
  v_phone text := '16045550200';
  v_sms text;
  v_sms_changed text;
  v_email text;
  v_payload text;
  v_recipient text;
  v_claim jsonb;
  v_result jsonb;
  v_claim_id uuid;
  v_token uuid;
  v_count integer;
BEGIN
  v_sms := jsonb_build_object(
    'v',1,'channel','sms','salonId',v_salon::text,'to','+1 (604) 555-0200',
    'body','Your NailIQ booking is confirmed.','statusCallbackUrl','https://example.test/twilio/status',
    'salonIsTest',true,'lang','en'
  )::text;
  v_sms_changed := jsonb_set(v_sms::jsonb, '{body}', '"Changed body"'::jsonb)::text;
  v_email := jsonb_build_object(
    'v',1,'channel','email','salonId',v_salon::text,'to','retry@example.test',
    'from','NailIQ <booking@example.test>','subject','Booking confirmed',
    'html','<p>Your booking is confirmed.</p>',
    'headers',jsonb_build_object('List-Unsubscribe','<https://example.test/unsubscribe>'),
    'replyTo','reply@example.test',
    'attachments',jsonb_build_array(jsonb_build_object(
      'filename','booking.ics','content','QkVHSU46VkNBTEVOREFSCkVORDpWQ0FMRU5EQVI=',
      'contentType','text/calendar'
    ))
  )::text;

  v_result := public.claim_booking_confirmation_delivery(
    v_salon, 'c5100000-0000-4000-8000-000000000010', 'sms', repeat('a',64), repeat('b',64)
  );
  IF v_result->>'code' <> 'dispatch_envelope_required' THEN
    RAISE EXCEPTION 'legacy claim did not fail closed: %', v_result;
  END IF;

  v_payload := encode(extensions.digest(convert_to(v_sms,'UTF8'),'sha256'),'hex');
  v_recipient := encode(extensions.digest(convert_to(v_phone,'UTF8'),'sha256'),'hex');
  v_claim := public.claim_booking_confirmation_delivery(
    v_salon, 'c5100000-0000-4000-8000-000000000010', 'sms',
    v_payload, v_recipient, v_sms
  );
  IF v_claim->>'code' <> 'claimed' OR v_claim->>'claimed' <> 'true' THEN
    RAISE EXCEPTION 'SMS initial claim failed: %', v_claim;
  END IF;
  v_claim_id := (v_claim->>'claim_id')::uuid;
  v_token := (v_claim->>'attempt_token')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_confirmation_dispatch_envelopes e
    WHERE e.claim_id=v_claim_id AND e.dispatch_envelope=v_sms
      AND e.payload_fingerprint=v_payload AND e.recipient_fingerprint=v_recipient
      AND e.contract_version=1
  ) THEN RAISE EXCEPTION 'SMS immutable envelope was not persisted'; END IF;

  v_result := public.claim_booking_confirmation_delivery(
    v_salon, 'c5100000-0000-4000-8000-000000000010', 'sms',
    v_payload, v_recipient, v_sms
  );
  IF v_result->>'code' <> 'in_flight' OR v_result->>'claimed' <> 'false' THEN
    RAISE EXCEPTION 'exact in-flight replay mismatch: %', v_result;
  END IF;
  v_result := public.claim_booking_confirmation_delivery(
    v_salon, 'c5100000-0000-4000-8000-000000000010', 'sms',
    encode(extensions.digest(convert_to(v_sms_changed,'UTF8'),'sha256'),'hex'),
    v_recipient, v_sms_changed
  );
  IF v_result->>'code' <> 'material_conflict' THEN
    RAISE EXCEPTION 'changed raw payload was not rejected: %', v_result;
  END IF;

  v_result := public.complete_booking_confirmation_delivery(
    v_claim_id, v_token, 'failed', NULL,
    'sms_rate_limited_pre_acceptance', 'retryable_pre_acceptance'
  );
  IF v_result->>'retry_scheduled' <> 'true'
     OR NOT EXISTS (SELECT 1 FROM public.booking_confirmation_dispatch_envelopes WHERE claim_id=v_claim_id) THEN
    RAISE EXCEPTION 'retryable completion lost envelope: %', v_result;
  END IF;
  UPDATE public.booking_notifications SET next_attempt_at=transaction_timestamp()-interval '1 second'
  WHERE id=v_claim_id;
  SELECT value INTO v_result
  FROM public.lease_due_booking_confirmation_retries(10) AS q(value)
  WHERE value->>'claim_id'=v_claim_id::text;
  IF v_result->>'code' <> 'leased' OR v_result->>'attempt_count' <> '2'
     OR v_result->>'dispatch_envelope' IS DISTINCT FROM v_sms
     OR v_result->>'payload_fingerprint' IS DISTINCT FROM v_payload
     OR v_result->>'recipient_fingerprint' IS DISTINCT FROM v_recipient THEN
    RAISE EXCEPTION 'retry lease is not reconstructable: %', v_result;
  END IF;
  v_token := (v_result->>'attempt_token')::uuid;
  v_result := public.complete_booking_confirmation_delivery(
    v_claim_id, v_token, 'sent', 'SM0123456789abcdef0123456789abcdef', NULL, 'none'
  );
  IF v_result->>'status' <> 'sent'
     OR EXISTS (SELECT 1 FROM public.booking_confirmation_dispatch_envelopes WHERE claim_id=v_claim_id) THEN
    RAISE EXCEPTION 'sent terminal cleanup failed: %', v_result;
  END IF;
  v_result := public.complete_booking_confirmation_delivery(
    v_claim_id, v_token, 'sent', 'SM0123456789abcdef0123456789abcdef', NULL, 'none'
  );
  IF v_result->>'code' <> 'already_completed' THEN
    RAISE EXCEPTION 'terminal completion replay failed: %', v_result;
  END IF;

  v_payload := encode(extensions.digest(convert_to(v_email,'UTF8'),'sha256'),'hex');
  v_recipient := encode(extensions.digest(convert_to('retry@example.test','UTF8'),'sha256'),'hex');
  v_claim := public.claim_booking_confirmation_delivery(
    v_salon, 'c5100000-0000-4000-8000-000000000011', 'email',
    v_payload, v_recipient, v_email
  );
  IF v_claim->>'code' <> 'claimed' THEN RAISE EXCEPTION 'email claim failed: %',v_claim; END IF;
  v_claim_id := (v_claim->>'claim_id')::uuid;
  v_token := (v_claim->>'attempt_token')::uuid;
  v_result := public.complete_booking_confirmation_delivery(
    v_claim_id, v_token, 'sent', 'resend-qa-receipt-1', NULL, 'none'
  );
  IF v_result->>'status' <> 'sent'
     OR EXISTS (SELECT 1 FROM public.booking_confirmation_dispatch_envelopes WHERE claim_id=v_claim_id) THEN
    RAISE EXCEPTION 'email terminal cleanup failed: %', v_result;
  END IF;

  v_result := public.claim_booking_confirmation_delivery(
    v_salon, 'c5100000-0000-4000-8000-000000000012', 'sms',
    encode(extensions.digest(convert_to(jsonb_set(v_sms::jsonb,'{to}','"+16045559999"')::text,'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(v_phone,'UTF8'),'sha256'),'hex'),
    jsonb_set(v_sms::jsonb,'{to}','"+16045559999"')::text
  );
  IF v_result->>'code' <> 'recipient_mismatch' THEN RAISE EXCEPTION 'recipient mismatch accepted: %',v_result; END IF;
  v_result := public.claim_booking_confirmation_delivery(
    v_salon, 'c5100000-0000-4000-8000-000000000012', 'sms',
    encode(extensions.digest(convert_to(repeat('x',262145),'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(v_phone,'UTF8'),'sha256'),'hex'), repeat('x',262145)
  );
  IF v_result->>'code' <> 'invalid_dispatch_envelope' THEN RAISE EXCEPTION 'oversize accepted: %',v_result; END IF;

  v_claim := public.claim_booking_confirmation_delivery_without_envelope_legacy(
    v_salon, 'c5100000-0000-4000-8000-000000000013', 'sms', repeat('c',64),
    encode(extensions.digest(convert_to(v_phone,'UTF8'),'sha256'),'hex')
  );
  v_claim_id := (v_claim->>'claim_id')::uuid;
  v_token := (v_claim->>'attempt_token')::uuid;
  PERFORM public.complete_booking_confirmation_delivery(
    v_claim_id, v_token, 'failed', NULL,
    'sms_unavailable_pre_acceptance', 'retryable_pre_acceptance'
  );
  UPDATE public.booking_notifications SET next_attempt_at=transaction_timestamp()-interval '1 second'
  WHERE id=v_claim_id;
  SELECT count(*) INTO v_count
  FROM public.lease_due_booking_confirmation_retries(10) AS q(value)
  WHERE value->>'claim_id'=v_claim_id::text;
  IF v_count <> 0 OR NOT EXISTS (
    SELECT 1 FROM public.booking_notifications n
    WHERE n.id=v_claim_id AND n.status='failed' AND n.failure_disposition='permanent'
      AND n.error_code='material_changed'
  ) THEN RAISE EXCEPTION 'missing-envelope legacy retry was dispatched: %',
    (SELECT row_to_json(x) FROM (
      SELECT n.status,n.failure_disposition,n.error_code,n.attempt_count
      FROM public.booking_notifications n WHERE n.id=v_claim_id
    ) x); END IF;

  v_payload := encode(extensions.digest(convert_to(v_sms,'UTF8'),'sha256'),'hex');
  v_recipient := encode(extensions.digest(convert_to(v_phone,'UTF8'),'sha256'),'hex');
  v_claim := public.claim_booking_confirmation_delivery(
    v_salon, 'c5100000-0000-4000-8000-000000000014', 'sms',
    v_payload, v_recipient, v_sms
  );
  v_claim_id := (v_claim->>'claim_id')::uuid;
  UPDATE public.booking_notifications SET updated_at=transaction_timestamp()-interval '16 minutes'
  WHERE id=v_claim_id;
  v_result := public.reconcile_stale_booking_confirmation_claims(10);
  IF EXISTS (SELECT 1 FROM public.booking_confirmation_dispatch_envelopes WHERE claim_id=v_claim_id)
     OR NOT EXISTS (SELECT 1 FROM public.booking_notifications WHERE id=v_claim_id AND status='unknown') THEN
    RAISE EXCEPTION 'stale terminal cleanup failed: %', v_result;
  END IF;

  v_sms := jsonb_set(v_sms::jsonb, '{salonId}', to_jsonb(v_other::text))::text;
  v_result := public.claim_booking_confirmation_delivery(
    v_other, 'c5100000-0000-4000-8000-000000000015', 'sms',
    encode(extensions.digest(convert_to(v_sms,'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to(v_phone,'UTF8'),'sha256'),'hex'), v_sms
  );
  IF v_result->>'code' <> 'booking_not_found' THEN RAISE EXCEPTION 'cross-tenant accepted: %',v_result; END IF;
END;
$behavior$;

ROLLBACK;

SELECT 'PASS immutable SMS/email booking confirmation envelope behavior' AS result;
