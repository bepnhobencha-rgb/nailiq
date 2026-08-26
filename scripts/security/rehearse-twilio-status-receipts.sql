\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE service_role;

INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES ('twilio-receipt-qa','Twilio receipt QA','Twilio receipt QA')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO public.salons(id,slug,name,phone,timezone,is_beta)
VALUES (
  '10100000-0000-4000-8000-000000000001',
  'twilio-receipt-qa',
  'Twilio Receipt QA',
  '+16045551011',
  'UTC',
  true
);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES (
  '10100000-0000-4000-8000-000000000002',
  '10100000-0000-4000-8000-000000000001',
  'Receipt service',
  2500,
  30,
  'twilio-receipt-qa'
);
INSERT INTO public.staff(id,salon_id,name,status)
VALUES (
  '10100000-0000-4000-8000-000000000003',
  '10100000-0000-4000-8000-000000000001',
  'Receipt staff',
  'active'
);
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,
  start_time_utc,end_time_utc,status,price_cents
) VALUES (
  '10100000-0000-4000-8000-000000000004',
  '10100000-0000-4000-8000-000000000001',
  '10100000-0000-4000-8000-000000000002',
  '10100000-0000-4000-8000-000000000003',
  'Receipt Fixture',
  '+16045551012',
  '2026-08-25T18:00:00Z',
  '2026-08-25T18:30:00Z',
  'confirmed',
  2500
);

RESET ROLE;
INSERT INTO public.staff_action_notification_outbox(
  id,salon_id,booking_id,request_id,event_type,occurrence_version,
  actor_user_id,actor_role,requested_channels,result_snapshot,
  material_snapshot,material_fingerprint,notification_delay_seconds,
  send_after,expires_at,status
) VALUES (
  '10100000-0000-4000-8000-000000000006',
  '10100000-0000-4000-8000-000000000001',
  '10100000-0000-4000-8000-000000000004',
  '10100000-0000-4000-8000-000000000008','create',1,
  null,'system','{"sms":true,"email":false}'::jsonb,'{}'::jsonb,
  null,repeat('a',64),0,transaction_timestamp(),
  transaction_timestamp()+interval '20 minutes','active'
);
INSERT INTO public.staff_action_notification_deliveries(
  id,outbox_id,salon_id,booking_id,channel,status,attempt_count,
  attempt_token,payload_fingerprint,recipient_fingerprint,claimed_at,
  provider_name
) VALUES (
  '10100000-0000-4000-8000-000000000007',
  '10100000-0000-4000-8000-000000000006',
  '10100000-0000-4000-8000-000000000001',
  '10100000-0000-4000-8000-000000000004','sms','sending',1,
  '10100000-0000-4000-8000-000000000009',repeat('b',64),repeat('c',64),
  transaction_timestamp(),'twilio'
);
SET LOCAL ROLE service_role;

DO $behavior$
DECLARE
  v_salon uuid := '10100000-0000-4000-8000-000000000001';
  v_booking uuid := '10100000-0000-4000-8000-000000000004';
  v_start timestamptz := '2026-08-25T18:00:00Z';
  v_sid_before text := 'SM11111111111111111111111111111111';
  v_sid_after text := 'MM22222222222222222222222222222222';
  v_unknown_sid text := 'SM33333333333333333333333333333333';
  v_generic_sid text := 'SM55555555555555555555555555555555';
  v_staff_sid text := 'MM66666666666666666666666666666666';
  v_review_early_sid text := 'SM77777777777777777777777777777777';
  v_review_late_sid text := 'MM88888888888888888888888888888888';
  v_generic_notification_id uuid := '10100000-0000-4000-8000-000000000005';
  v_staff_outbox_id uuid := '10100000-0000-4000-8000-000000000006';
  v_staff_delivery_id uuid := '10100000-0000-4000-8000-000000000007';
  v_review_early_id uuid := '10100000-0000-4000-8000-000000000010';
  v_review_late_id uuid := '10100000-0000-4000-8000-000000000011';
  v_claim jsonb;
  v_result jsonb;
  v_claim_id uuid;
  v_received_at timestamptz;
  v_delivered_at timestamptz;
  v_fingerprint text;
BEGIN
  -- Callback-before-completion is durably pending, then completion applies it.
  v_claim := public.claim_booking_reminder_delivery(
    v_salon,v_booking,v_start,'24h','sms'
  );
  v_claim_id := (v_claim->>'claim_id')::uuid;
  IF v_claim->>'code' <> 'claimed' THEN
    RAISE EXCEPTION 'SMS claim failed: %', v_claim;
  END IF;

  v_result := public.record_twilio_message_status_receipt(
    v_sid_before,'delivered',null
  );
  IF v_result->>'code' <> 'pending' THEN
    RAISE EXCEPTION 'early callback was not retained: %', v_result;
  END IF;
  SELECT received_at,receipt_fingerprint
  INTO v_received_at,v_fingerprint
  FROM public.twilio_message_status_receipts
  WHERE message_sid=v_sid_before;

  v_result := public.complete_booking_reminder_delivery(
    v_claim_id,'sent',v_sid_before,null
  );
  IF v_result->>'code' <> 'completed' THEN
    RAISE EXCEPTION 'SMS completion failed: %', v_result;
  END IF;

  SELECT delivered_at INTO v_delivered_at
  FROM public.booking_notifications
  WHERE twilio_message_sid=v_sid_before
    AND booking_id=v_booking
    AND salon_id=v_salon
    AND notification_type='reminder_24h'
    AND channel='sms'
    AND status='delivered'
    AND failed_at IS NULL
    AND error_code IS NULL;
  IF v_delivered_at IS NULL THEN
    RAISE EXCEPTION 'pending delivered callback was not atomically applied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_reminder_delivery_claims
    WHERE id=v_claim_id
      AND status='sent'
      AND provider_message_id=v_sid_before
      AND delivery_status='delivered'
      AND delivery_error_code IS NULL
      AND delivery_received_at IS NOT NULL
      AND delivery_fingerprint=v_fingerprint
  ) OR NOT EXISTS (
    SELECT 1 FROM public.twilio_message_status_receipts
    WHERE message_sid=v_sid_before
      AND applied_at IS NOT NULL
      AND notification_id IS NOT NULL
      AND reminder_claim_id=v_claim_id
  ) THEN
    RAISE EXCEPTION 'claim/inbox callback binding is incomplete';
  END IF;

  -- Exact replay is write-free; first truth and its timestamps remain stable.
  v_result := public.record_twilio_message_status_receipt(
    v_sid_before,'delivered',null
  );
  IF v_result->>'code' <> 'exact_replay' THEN
    RAISE EXCEPTION 'exact callback replay was not recognized: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.twilio_message_status_receipts
    WHERE message_sid=v_sid_before
      AND received_at=v_received_at
      AND receipt_fingerprint=v_fingerprint
  ) OR NOT EXISTS (
    SELECT 1 FROM public.booking_notifications
    WHERE twilio_message_sid=v_sid_before
      AND delivered_at=v_delivered_at
      AND failed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'exact replay rewrote first receipt state';
  END IF;

  -- A changed terminal is durably recorded but never overwrites first truth.
  v_result := public.record_twilio_message_status_receipt(
    v_sid_before,'failed','30003'
  );
  IF v_result->>'code' <> 'durable_conflict' THEN
    RAISE EXCEPTION 'terminal conflict was not durably captured: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.twilio_message_status_receipts
    WHERE message_sid=v_sid_before
      AND terminal_status='delivered'
      AND error_code IS NULL
      AND conflict_status='failed'
      AND conflict_error_code='30003'
      AND conflict_fingerprint IS NOT NULL
      AND conflict_recorded_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.booking_notifications
    WHERE twilio_message_sid=v_sid_before
      AND status='delivered'
      AND delivered_at=v_delivered_at
      AND failed_at IS NULL
      AND error_code IS NULL
  ) THEN
    RAISE EXCEPTION 'terminal conflict changed first truth';
  END IF;

  -- Callback-after-completion binds failure columns consistently.
  v_claim := public.claim_booking_reminder_delivery(
    v_salon,v_booking,v_start,'3h','sms'
  );
  v_claim_id := (v_claim->>'claim_id')::uuid;
  v_result := public.complete_booking_reminder_delivery(
    v_claim_id,'sent',v_sid_after,null
  );
  IF v_result->>'code' <> 'completed' THEN
    RAISE EXCEPTION 'second SMS completion failed: %', v_result;
  END IF;
  v_result := public.record_twilio_message_status_receipt(
    v_sid_after,'failed','30003'
  );
  IF v_result->>'code' <> 'applied' THEN
    RAISE EXCEPTION 'late failure callback was not applied: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_notifications
    WHERE twilio_message_sid=v_sid_after
      AND status='failed'
      AND delivered_at IS NULL
      AND failed_at IS NOT NULL
      AND error_code='30003'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.booking_reminder_delivery_claims
    WHERE id=v_claim_id
      AND status='sent'
      AND delivery_status='failed'
      AND delivery_error_code='30003'
      AND delivery_received_at IS NOT NULL
      AND delivery_fingerprint ~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'failure callback columns are inconsistent';
  END IF;

  -- Completion replay must be exact; changed material is rejected.
  v_result := public.complete_booking_reminder_delivery(
    v_claim_id,'sent',v_sid_after,null
  );
  IF v_result->>'code' <> 'already_completed' THEN
    RAISE EXCEPTION 'exact completion replay failed: %', v_result;
  END IF;
  v_result := public.complete_booking_reminder_delivery(
    v_claim_id,'sent','SM44444444444444444444444444444444',null
  );
  IF v_result->>'code' <> 'completion_conflict' THEN
    RAISE EXCEPTION 'changed completion material was accepted: %', v_result;
  END IF;

  -- A valid unknown SID remains one PII-free pending inbox row.
  v_result := public.record_twilio_message_status_receipt(
    v_unknown_sid,'undelivered','30007'
  );
  IF v_result->>'code' <> 'pending' THEN
    RAISE EXCEPTION 'unknown SID was not retained pending: %', v_result;
  END IF;
  v_result := public.record_twilio_message_status_receipt(
    v_unknown_sid,'undelivered','30007'
  );
  IF v_result->>'code' <> 'pending' THEN
    RAISE EXCEPTION 'pending replay changed outcome: %', v_result;
  END IF;
  IF (SELECT count(*) FROM public.twilio_message_status_receipts
      WHERE message_sid=v_unknown_sid) <> 1
     OR EXISTS (
       SELECT 1 FROM public.twilio_message_status_receipts
       WHERE message_sid=v_unknown_sid
         AND (
           applied_at IS NOT NULL
           OR notification_id IS NOT NULL
           OR reminder_claim_id IS NOT NULL
           OR staff_action_delivery_id IS NOT NULL
         )
     ) THEN
    RAISE EXCEPTION 'unknown SID inbox state is not uniquely pending';
  END IF;

  -- Generic callback-before-correlation drains when the notification later
  -- stores the SID (booking confirmation and review-request race shape).
  INSERT INTO public.booking_notifications(
    id,booking_id,salon_id,notification_type,channel,status
  ) VALUES (
    v_generic_notification_id,v_booking,v_salon,'review_request','sms','sending'
  );
  v_result := public.record_twilio_message_status_receipt(
    v_generic_sid,'delivered',null
  );
  IF v_result->>'code' <> 'pending' THEN
    RAISE EXCEPTION 'generic early callback was not retained: %', v_result;
  END IF;
  UPDATE public.booking_notifications
  SET status='sent',twilio_message_sid=v_generic_sid,
      sent_at=transaction_timestamp()
  WHERE id=v_generic_notification_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_notifications n
    JOIN public.twilio_message_status_receipts r ON r.notification_id=n.id
    WHERE n.id=v_generic_notification_id
      AND n.status='delivered'
      AND n.delivered_at IS NOT NULL
      AND n.failed_at IS NULL
      AND r.message_sid=v_generic_sid
      AND r.applied_at IS NOT NULL
      AND r.staff_action_delivery_id IS NULL
  ) THEN
    RAISE EXCEPTION 'generic SID correlation did not drain pending callback';
  END IF;

  -- Review callbacks carry the pre-provider notification id in their signed
  -- URL, so callback response loss can bind the SID before app completion.
  INSERT INTO public.booking_notifications(
    id,booking_id,salon_id,notification_type,channel,status
  ) VALUES (
    v_review_early_id,v_booking,v_salon,'review_request','sms','sending'
  );
  v_result := public.record_twilio_review_request_status_receipt(
    v_review_early_id,v_review_early_sid,'delivered',null
  );
  IF v_result->>'code' <> 'applied' THEN
    RAISE EXCEPTION 'review callback-first correlation failed: %', v_result;
  END IF;
  v_result := public.complete_review_request_sms_notification(
    v_review_early_id,'sent',v_review_early_sid,null
  );
  IF v_result->>'code' <> 'callback_terminal' THEN
    RAISE EXCEPTION 'review callback-first completion replay failed: %', v_result;
  END IF;

  INSERT INTO public.booking_notifications(
    id,booking_id,salon_id,notification_type,channel,status
  ) VALUES (
    v_review_late_id,v_booking,v_salon,'review_request','sms','sending'
  );
  v_result := public.complete_review_request_sms_notification(
    v_review_late_id,'sent',v_review_late_sid,null
  );
  IF v_result->>'code' <> 'completed' THEN
    RAISE EXCEPTION 'review completion-first correlation failed: %', v_result;
  END IF;
  v_result := public.record_twilio_review_request_status_receipt(
    v_review_late_id,v_review_late_sid,'failed','30003'
  );
  IF v_result->>'code' <> 'applied' OR NOT EXISTS (
    SELECT 1 FROM public.booking_notifications n
    JOIN public.twilio_message_status_receipts r ON r.notification_id=n.id
    WHERE n.id=v_review_late_id
      AND n.status='failed'
      AND n.failed_at IS NOT NULL
      AND n.delivered_at IS NULL
      AND n.error_code='30003'
      AND r.message_sid=v_review_late_sid
      AND r.applied_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'review completion-first callback was not applied: %', v_result;
  END IF;

  -- Deleting a correlated notification must not be blocked by ON DELETE SET
  -- NULL. The PII-free first receipt truth remains durable after its target.
  DELETE FROM public.booking_notifications WHERE id=v_generic_notification_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.twilio_message_status_receipts
    WHERE message_sid=v_generic_sid
      AND applied_at IS NOT NULL
      AND notification_id IS NULL
  ) THEN
    RAISE EXCEPTION 'applied generic receipt did not survive target deletion';
  END IF;

  -- Staff-action SMS has its own durable delivery row. A callback that wins
  -- before completion is drained by the provider_message_id transition.
  v_result := public.record_twilio_message_status_receipt(
    v_staff_sid,'undelivered','30007'
  );
  IF v_result->>'code' <> 'pending' THEN
    RAISE EXCEPTION 'staff early callback was not retained: %', v_result;
  END IF;
  v_result := public.complete_staff_action_notification_delivery(
    v_staff_delivery_id,
    '10100000-0000-4000-8000-000000000009',
    'sent',v_staff_sid,null,'none'
  );
  IF v_result->>'code' <> 'completed' THEN
    RAISE EXCEPTION 'staff SMS completion failed: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_action_notification_deliveries d
    JOIN public.twilio_message_status_receipts r
      ON r.staff_action_delivery_id=d.id
    WHERE d.id=v_staff_delivery_id
      AND d.status='sent'
      AND d.delivery_status='undelivered'
      AND d.delivery_error_code='30007'
      AND d.delivery_received_at IS NOT NULL
      AND d.delivery_fingerprint=r.receipt_fingerprint
      AND r.message_sid=v_staff_sid
      AND r.applied_at IS NOT NULL
      AND r.notification_id IS NULL
  ) THEN
    RAISE EXCEPTION 'staff SID correlation did not drain pending callback';
  END IF;

END;
$behavior$;

RESET ROLE;
DELETE FROM public.staff_action_notification_outbox
WHERE id='10100000-0000-4000-8000-000000000006';
DO $staff_delete_boundary$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.twilio_message_status_receipts
    WHERE message_sid='MM66666666666666666666666666666666'
      AND applied_at IS NOT NULL
      AND staff_action_delivery_id IS NULL
  ) THEN
    RAISE EXCEPTION 'applied staff receipt did not survive target deletion';
  END IF;
END;
$staff_delete_boundary$;
SET LOCAL ROLE service_role;

ROLLBACK;

DO $cleanup$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.salons
    WHERE id='10100000-0000-4000-8000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM public.booking_reminder_delivery_claims
    WHERE booking_id='10100000-0000-4000-8000-000000000004'
  ) OR EXISTS (
    SELECT 1 FROM public.twilio_message_status_receipts
    WHERE message_sid IN (
      'SM11111111111111111111111111111111',
      'MM22222222222222222222222222222222',
      'SM33333333333333333333333333333333',
      'SM55555555555555555555555555555555',
      'MM66666666666666666666666666666666',
      'SM77777777777777777777777777777777',
      'MM88888888888888888888888888888888'
    )
  ) THEN
    RAISE EXCEPTION 'Twilio receipt rehearsal left fixture rows';
  END IF;
END;
$cleanup$;

SELECT 'twilio_status_receipt_rehearsal_pass' AS result;
