\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.service_categories(slug, name_en, name_vi)
VALUES ('customer-delivery-truth-qa-20260828', 'Customer delivery truth QA', 'Customer delivery truth QA')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.salons(id, slug, name, phone, timezone)
VALUES (
  'd82c0000-0000-4000-8000-000000000001',
  'customer-delivery-truth-qa-20260828',
  'Customer Delivery Truth QA',
  '+16045550820',
  'America/Vancouver'
);

INSERT INTO public.services(id, salon_id, name, price_cents, duration_minutes, category)
VALUES (
  'd82c0000-0000-4000-8000-000000000002',
  'd82c0000-0000-4000-8000-000000000001',
  'Delivery truth service', 4500, 45, 'customer-delivery-truth-qa-20260828'
);

INSERT INTO public.staff(id, salon_id, name, status)
VALUES (
  'd82c0000-0000-4000-8000-000000000003',
  'd82c0000-0000-4000-8000-000000000001',
  'Delivery truth staff', 'active'
);

INSERT INTO public.bookings(
  id, salon_id, service_id, staff_id, client_name, client_email, client_phone,
  start_time_utc, end_time_utc, status, price_cents
) VALUES
  ('d82c0000-0000-4000-8000-000000000010', 'd82c0000-0000-4000-8000-000000000001',
   'd82c0000-0000-4000-8000-000000000002', 'd82c0000-0000-4000-8000-000000000003',
   'Confirmation guest', 'confirm@example.invalid', '16045550821',
   transaction_timestamp() + interval '3 days', transaction_timestamp() + interval '3 days 45 minutes',
   'confirmed', 4500),
  ('d82c0000-0000-4000-8000-000000000011', 'd82c0000-0000-4000-8000-000000000001',
   'd82c0000-0000-4000-8000-000000000002', 'd82c0000-0000-4000-8000-000000000003',
   'Reminder guest', 'reminder@example.invalid', '16045550822',
   transaction_timestamp() + interval '4 days', transaction_timestamp() + interval '4 days 45 minutes',
   'confirmed', 4500),
  ('d82c0000-0000-4000-8000-000000000012', 'd82c0000-0000-4000-8000-000000000001',
   'd82c0000-0000-4000-8000-000000000002', 'd82c0000-0000-4000-8000-000000000003',
   'Transition guest', 'transition@example.invalid', '16045550823',
   transaction_timestamp() + interval '5 days', transaction_timestamp() + interval '5 days 45 minutes',
   'cancelled', 4500);

DO $behavior$
DECLARE
  v_salon uuid := 'd82c0000-0000-4000-8000-000000000001';
  v_confirmation uuid;
  v_reminder uuid;
  v_transition uuid := 'd82c0000-0000-4000-8000-000000000030';
  v_confirm_hash text := encode(extensions.digest(convert_to('confirm@example.invalid', 'UTF8'), 'sha256'), 'hex');
  v_reminder_hash text := encode(extensions.digest(convert_to('reminder@example.invalid', 'UTF8'), 'sha256'), 'hex');
  v_transition_hash text := encode(extensions.digest(convert_to('transition@example.invalid', 'UTF8'), 'sha256'), 'hex');
  v_result jsonb;
BEGIN
  INSERT INTO public.booking_notifications(
    booking_id, salon_id, notification_type, channel, status, sent_at,
    provider_name, recipient_fingerprint
  ) VALUES (
    'd82c0000-0000-4000-8000-000000000010', v_salon,
    'booking_confirmation', 'email', 'sending', NULL, 'resend', v_confirm_hash
  ) RETURNING id INTO v_confirmation;

  INSERT INTO public.booking_reminder_delivery_claims(
    salon_id, booking_id, appointment_start_utc, reminder_type, channel
  ) SELECT v_salon, b.id, b.start_time_utc, '24h', 'email'
    FROM public.bookings b WHERE b.id = 'd82c0000-0000-4000-8000-000000000011'
  RETURNING id INTO v_reminder;

  INSERT INTO public.customer_booking_transition_email_outbox(
    id, salon_id, booking_id, event_type, transition_version, occurrence_key,
    previous_status, current_status, previous_start_time_utc, new_start_time_utc,
    transitioned_at, recipient_email, recipient_fingerprint, locale, client_name,
    service_id, service_name, staff_id, staff_name, salon_name, salon_slug,
    salon_timezone, material_fingerprint, status, attempt_count, attempt_token,
    claimed_at, payload_fingerprint, expires_at
  ) VALUES (
    v_transition, v_salon, 'd82c0000-0000-4000-8000-000000000012', 'cancel', 1,
    repeat('1', 64), 'confirmed', 'cancelled',
    transaction_timestamp() + interval '5 days', transaction_timestamp() + interval '5 days',
    transaction_timestamp(), 'transition@example.invalid', v_transition_hash, 'en',
    'Transition guest', 'd82c0000-0000-4000-8000-000000000002',
    'Delivery truth service', 'd82c0000-0000-4000-8000-000000000003',
    'Delivery truth staff', 'Customer Delivery Truth QA', 'customer-delivery-truth-qa-20260828',
    'America/Vancouver', repeat('2', 64), 'sending', 1,
    'd82c0000-0000-4000-8000-000000000031', transaction_timestamp(), repeat('3', 64),
    transaction_timestamp() + interval '24 hours'
  );

  v_result := public.record_resend_customer_delivery_event(
    'confirmation', v_confirmation, 'evt-customer-confirm-delivered',
    'msg-customer-confirm', 'email.delivered', v_confirm_hash,
    transaction_timestamp() - interval '2 minutes', repeat('a', 64)
  );
  IF v_result->>'code' <> 'event_applied'
     OR NOT EXISTS (SELECT 1 FROM public.booking_notifications n
       WHERE n.id = v_confirmation AND n.status = 'delivered'
         AND n.email_delivery_status = 'delivered' AND n.delivered_at IS NOT NULL) THEN
    RAISE EXCEPTION 'confirmation delivery truth failed: %', v_result;
  END IF;

  v_result := public.record_resend_customer_delivery_event(
    'reminder', v_reminder, 'evt-customer-reminder-delivered',
    'msg-customer-reminder', 'email.delivered', v_reminder_hash,
    transaction_timestamp() - interval '90 seconds', repeat('b', 64)
  );
  IF v_result->>'code' <> 'event_applied'
     OR NOT EXISTS (SELECT 1 FROM public.booking_reminder_delivery_claims c
       WHERE c.id = v_reminder AND c.email_delivery_status = 'delivered')
     OR NOT EXISTS (SELECT 1 FROM public.booking_notifications n
       WHERE n.booking_id = 'd82c0000-0000-4000-8000-000000000011'
         AND n.channel = 'email' AND n.status = 'delivered') THEN
    RAISE EXCEPTION 'reminder delivery truth/projection failed: %', v_result;
  END IF;

  v_result := public.record_resend_customer_delivery_event(
    'transition', v_transition, 'evt-customer-transition-complaint',
    'msg-customer-transition', 'email.complained', v_transition_hash,
    transaction_timestamp() - interval '1 minute', repeat('c', 64)
  );
  IF v_result->>'code' <> 'event_applied'
     OR NOT EXISTS (SELECT 1 FROM public.customer_booking_transition_email_outbox o
       WHERE o.id = v_transition AND o.email_delivery_status = 'complained')
     OR public.customer_email_delivery_suppression_reason(v_salon, v_transition_hash) <> 'complained'
     OR NOT EXISTS (SELECT 1 FROM public.booking_notifications n
       WHERE n.booking_id = 'd82c0000-0000-4000-8000-000000000012'
         AND n.channel = 'email' AND n.status = 'failed') THEN
    RAISE EXCEPTION 'transition complaint/suppression/projection failed: %', v_result;
  END IF;

  v_result := public.record_resend_customer_delivery_event(
    'transition', v_transition, 'evt-customer-transition-complaint',
    'msg-customer-transition', 'email.complained', v_transition_hash,
    transaction_timestamp() - interval '1 minute', repeat('c', 64)
  );
  IF v_result->>'code' <> 'event_replay'
     OR (SELECT count(*) FROM public.resend_customer_delivery_events
       WHERE provider_event_id = 'evt-customer-transition-complaint') <> 1 THEN
    RAISE EXCEPTION 'exact replay was not idempotent: %', v_result;
  END IF;

  v_result := public.record_resend_customer_delivery_event(
    'transition', v_transition, 'evt-customer-transition-complaint',
    'msg-customer-transition', 'email.complained', v_transition_hash,
    transaction_timestamp() - interval '1 minute', repeat('d', 64)
  );
  IF v_result->>'code' <> 'event_conflict' THEN
    RAISE EXCEPTION 'changed replay did not conflict: %', v_result;
  END IF;
END;
$behavior$;

DO $boundary$
BEGIN
  IF has_table_privilege('anon', 'public.resend_customer_delivery_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.resend_customer_delivery_events', 'SELECT')
     OR has_table_privilege('service_role', 'public.resend_customer_delivery_events', 'SELECT')
     OR has_table_privilege('anon', 'public.customer_email_delivery_suppressions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.customer_email_delivery_suppressions', 'SELECT')
     OR has_table_privilege('service_role', 'public.customer_email_delivery_suppressions', 'SELECT') THEN
    RAISE EXCEPTION 'customer delivery truth tables became directly reachable';
  END IF;
  IF has_function_privilege(
       'anon',
       'public.record_resend_customer_delivery_event(text,uuid,text,text,text,text,timestamptz,text)'::regprocedure,
       'EXECUTE'
     ) OR has_function_privilege(
       'authenticated',
       'public.record_resend_customer_delivery_event(text,uuid,text,text,text,text,timestamptz,text)'::regprocedure,
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'service_role',
       'public.record_resend_customer_delivery_event(text,uuid,text,text,text,text,timestamptz,text)'::regprocedure,
       'EXECUTE'
     ) OR has_function_privilege(
       'service_role',
       'public.reconcile_resend_customer_delivery_events(text,uuid)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'customer delivery truth RPC ACL mismatch';
  END IF;
END;
$boundary$;

ROLLBACK;
