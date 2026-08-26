\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('transition-email-qa','Transition email QA','Transition email QA')
ON CONFLICT(slug) DO NOTHING;

INSERT INTO public.salons(id,slug,name,phone,salon_phone,timezone,default_notification_locale)
VALUES
  ('c5000000-0000-4000-8000-000000000001','transition-email-qa','Transition Email QA','+16045550100','+16045550101','America/Vancouver','vi'),
  ('c5000000-0000-4000-8000-000000000002','transition-email-other','Transition Email Other','+16045550102',NULL,'UTC','en');

INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('c5000000-0000-4000-8000-000000000003',
  'c5000000-0000-4000-8000-000000000001','Transition service',3500,45,'transition-email-qa');
INSERT INTO public.staff(id,salon_id,name,status)
VALUES('c5000000-0000-4000-8000-000000000004',
  'c5000000-0000-4000-8000-000000000001','Transition staff','active');

INSERT INTO auth.users(
  id,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at
) VALUES(
  'c5000000-0000-4000-8000-000000000005',
  'transition-email-desk@nailiq.invalid','',transaction_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,
  transaction_timestamp()
);
INSERT INTO public.salon_members(salon_id,user_id,role) VALUES(
  'c5000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000005','owner'
);

INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_email,client_locale,
  start_time_utc,end_time_utc,status,price_cents
)
SELECT
  ('c5000000-0000-4000-8000-'||lpad(gs::text,12,'0'))::uuid,
  'c5000000-0000-4000-8000-000000000001',
  'c5000000-0000-4000-8000-000000000003',
  CASE WHEN gs IN (19,20) THEN NULL ELSE 'c5000000-0000-4000-8000-000000000004'::uuid END,
  'Transition guest '||gs,
  CASE WHEN gs=16 THEN NULL ELSE 'transition@example.test' END,
  'vi-CA',transaction_timestamp()+make_interval(days=>gs),
  transaction_timestamp()+make_interval(days=>gs,mins=>45),'confirmed',3500
FROM generate_series(10,20) gs;

INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_email,client_locale,
  start_time_utc,end_time_utc,status,price_cents
) VALUES
  ('c5000000-0000-4000-8000-000000000021','c5000000-0000-4000-8000-000000000001',
   'c5000000-0000-4000-8000-000000000003','c5000000-0000-4000-8000-000000000004',
   'Late cancel guest','transition@example.test','en',transaction_timestamp()+interval '10 minutes',
   transaction_timestamp()+interval '55 minutes','confirmed',3500),
  ('c5000000-0000-4000-8000-000000000022','c5000000-0000-4000-8000-000000000001',
   'c5000000-0000-4000-8000-000000000003','c5000000-0000-4000-8000-000000000004',
   'Past move guest','transition@example.test','en',transaction_timestamp()-interval '1 hour',
   transaction_timestamp()-interval '15 minutes','confirmed',3500);

INSERT INTO public.booking_reminder_tokens(id,booking_id,salon_id,expires_at)
VALUES
  ('c5000000-0000-4000-8000-000000000119','c5000000-0000-4000-8000-000000000019','c5000000-0000-4000-8000-000000000001',transaction_timestamp()+interval '1 hour'),
  ('c5000000-0000-4000-8000-000000000120','c5000000-0000-4000-8000-000000000020','c5000000-0000-4000-8000-000000000001',transaction_timestamp()+interval '1 hour');

-- Staff/Voice mutation inputs are consumed atomically and persisted false/null.
SET LOCAL ROLE service_role;
UPDATE public.bookings SET
  start_time_utc=start_time_utc+interval '1 hour',
  end_time_utc=end_time_utc+interval '1 hour',
  customer_transition_email_requested=true,
  customer_transition_email_not_before=transaction_timestamp()+interval '20 seconds'
WHERE id='c5000000-0000-4000-8000-000000000010';
UPDATE public.bookings SET status='cancelled',
  customer_transition_email_requested=true,
  customer_transition_email_not_before=transaction_timestamp()
WHERE id='c5000000-0000-4000-8000-000000000021';
UPDATE public.bookings SET
  start_time_utc=transaction_timestamp()+interval '2 days',
  end_time_utc=transaction_timestamp()+interval '2 days 45 minutes',
  customer_transition_email_requested=true,
  customer_transition_email_not_before=transaction_timestamp()
WHERE id='c5000000-0000-4000-8000-000000000022';
RESET ROLE;

DO $behavior$
DECLARE
  v_salon uuid:='c5000000-0000-4000-8000-000000000001';
  v_other uuid:='c5000000-0000-4000-8000-000000000002';
  v_email_hash text:=encode(extensions.digest(convert_to('transition@example.test','UTF8'),'sha256'),'hex');
  v_payload text:=repeat('a',64);
  v_result jsonb;
  v_claim jsonb;
  v_outbox uuid;
  v_token uuid;
  v_token2 uuid;
  v_count integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.bookings
    WHERE id='c5000000-0000-4000-8000-000000000010'
      AND customer_transition_version=1 AND customer_transition_kind='reschedule'
      AND customer_transition_email_requested=false
      AND customer_transition_email_not_before IS NULL)
  OR NOT EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox
    WHERE booking_id='c5000000-0000-4000-8000-000000000010'
      AND status='pending' AND available_at>=transaction_timestamp()+interval '20 seconds') THEN
    RAISE EXCEPTION 'atomic delayed staff transition/request capture failed';
  END IF;
  IF (SELECT count(*) FROM public.customer_booking_transition_email_outbox
      WHERE booking_id IN ('c5000000-0000-4000-8000-000000000021','c5000000-0000-4000-8000-000000000022')
        AND status='pending' AND expires_at=transitioned_at+interval '30 minutes')<>2 THEN
    RAISE EXCEPTION 'late cancel or past-to-future reschedule lost bounded post-transition window';
  END IF;
  v_result:=public.claim_customer_booking_transition_email(v_salon,
    'c5000000-0000-4000-8000-000000000010','reschedule',1,v_payload,v_email_hash);
  IF v_result->>'code'<>'not_due' THEN RAISE EXCEPTION 'delay bypassed: %',v_result; END IF;
  v_result:=public.load_customer_booking_transition_email_material(v_other,
    'c5000000-0000-4000-8000-000000000010','reschedule',1);
  IF v_result->>'code'<>'transition_not_found' THEN RAISE EXCEPTION 'cross-tenant load leaked: %',v_result; END IF;

  UPDATE public.customer_booking_transition_email_outbox SET available_at=transaction_timestamp()
  WHERE booking_id='c5000000-0000-4000-8000-000000000010';
  SELECT value INTO v_result FROM public.discover_due_customer_booking_transition_emails(10) value
  WHERE value->>'booking_id'='c5000000-0000-4000-8000-000000000010';
  IF v_result->>'salon_id'<>v_salon::text OR v_result->>'recipient_fingerprint'<>v_email_hash
     OR v_result->'snapshot'->>'recipient_email'<>'transition@example.test' THEN
    RAISE EXCEPTION 'due discovery material mismatch: %',v_result;
  END IF;
  v_result:=public.claim_customer_booking_transition_email(v_salon,
    'c5000000-0000-4000-8000-000000000010','reschedule',1,v_payload,repeat('f',64));
  IF v_result->>'code'<>'recipient_fingerprint_mismatch' THEN RAISE EXCEPTION 'recipient mismatch accepted'; END IF;
  v_claim:=public.claim_customer_booking_transition_email(v_salon,
    'c5000000-0000-4000-8000-000000000010','reschedule',1,v_payload,v_email_hash);
  IF v_claim->>'code'<>'claimed' THEN RAISE EXCEPTION 'initial claim failed: %',v_claim; END IF;
  v_outbox:=(v_claim->>'outbox_id')::uuid; v_token:=(v_claim->>'attempt_token')::uuid;
  v_result:=public.complete_customer_booking_transition_email(v_outbox,v_token,
    'failed',NULL,'raw_provider_503','retryable_pre_acceptance');
  IF v_result->>'status'<>'unknown' OR v_result->>'retry_scheduled'<>'false' THEN
    RAISE EXCEPTION 'caller opened retry for unclassified provider outcome: %',v_result;
  END IF;

  -- Legacy update is inert until an exact-version activation.
  UPDATE public.bookings SET start_time_utc=start_time_utc+interval '1 hour',
    end_time_utc=end_time_utc+interval '1 hour'
  WHERE id='c5000000-0000-4000-8000-000000000011';
  IF NOT EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox
    WHERE booking_id='c5000000-0000-4000-8000-000000000011' AND status='awaiting_activation') THEN
    RAISE EXCEPTION 'legacy transition was not default-inert';
  END IF;
  v_result:=public.claim_customer_booking_transition_email(v_salon,
    'c5000000-0000-4000-8000-000000000011','reschedule',1,v_payload,v_email_hash);
  IF v_result->>'code'<>'not_activated' THEN RAISE EXCEPTION 'unactivated claim opened: %',v_result; END IF;
  v_result:=public.activate_customer_booking_transition_email(v_salon,
    'c5000000-0000-4000-8000-000000000011','reschedule',1,transaction_timestamp());
  IF v_result->>'code'<>'activated' THEN RAISE EXCEPTION 'exact activation failed: %',v_result; END IF;
  v_claim:=public.claim_customer_booking_transition_email(v_salon,
    'c5000000-0000-4000-8000-000000000011','reschedule',1,v_payload,v_email_hash);
  v_outbox:=(v_claim->>'outbox_id')::uuid; v_token:=(v_claim->>'attempt_token')::uuid;
  v_result:=public.complete_customer_booking_transition_email(v_outbox,v_token,'failed',NULL,
    'email_rate_limited_pre_acceptance','permanent');
  IF v_result->>'failure_disposition'<>'retryable_pre_acceptance'
     OR v_result->>'caller_disposition_accepted'<>'false'
     OR NOT EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox
       WHERE id=v_outbox AND next_attempt_at BETWEEN transaction_timestamp()+interval '5 minutes'
       AND transaction_timestamp()+interval '6 minutes') THEN
    RAISE EXCEPTION 'server-derived 5m+jitter retry mismatch: %',v_result;
  END IF;
  UPDATE public.customer_booking_transition_email_outbox
    SET next_attempt_at=transaction_timestamp()-interval '1 second' WHERE id=v_outbox;
  SELECT value INTO v_result FROM public.lease_due_customer_booking_transition_email_retries(10) value
  WHERE value->>'outbox_id'=v_outbox::text;
  IF (v_result->>'attempt_count')::integer<>2
     OR v_result->>'payload_fingerprint'<>v_payload
     OR v_result->>'recipient_fingerprint'<>v_email_hash THEN
    RAISE EXCEPTION 'bound retry lease mismatch: %',v_result;
  END IF;
  v_token2:=(v_result->>'attempt_token')::uuid;
  v_result:=public.complete_customer_booking_transition_email(v_outbox,v_token2,'failed',NULL,
    'email_rate_limited_pre_acceptance','retryable_pre_acceptance');
  IF v_result->>'failure_disposition'<>'permanent' OR v_result->>'retry_scheduled'<>'false' THEN
    RAISE EXCEPTION 'attempt two did not exhaust: %',v_result;
  END IF;
  v_result:=public.complete_customer_booking_transition_email(v_outbox,v_token2,'failed',NULL,
    'email_rate_limited_pre_acceptance','retryable_pre_acceptance');
  IF v_result->>'code'<>'already_completed' THEN RAISE EXCEPTION 'exact completion replay failed'; END IF;
  v_result:=public.complete_customer_booking_transition_email(v_outbox,v_token2,'unknown',NULL,
    'transport_timeout','none');
  IF v_result->>'code'<>'completion_conflict' THEN RAISE EXCEPTION 'changed completion did not conflict'; END IF;

  -- Receipt truth: blank provider receipt becomes terminal unknown; nonblank Resend ID is sent.
  UPDATE public.bookings SET start_time_utc=start_time_utc+interval '1 hour',end_time_utc=end_time_utc+interval '1 hour'
  WHERE id='c5000000-0000-4000-8000-000000000012';
  PERFORM public.activate_customer_booking_transition_email(v_salon,'c5000000-0000-4000-8000-000000000012','reschedule',1,transaction_timestamp());
  v_claim:=public.claim_customer_booking_transition_email(v_salon,'c5000000-0000-4000-8000-000000000012','reschedule',1,v_payload,v_email_hash);
  v_result:=public.complete_customer_booking_transition_email((v_claim->>'outbox_id')::uuid,(v_claim->>'attempt_token')::uuid,'sent','  ',NULL,'none');
  IF v_result->>'status'<>'unknown' THEN RAISE EXCEPTION 'blank receipt was accepted: %',v_result; END IF;
  UPDATE public.bookings SET start_time_utc=start_time_utc+interval '1 hour',end_time_utc=end_time_utc+interval '1 hour'
  WHERE id='c5000000-0000-4000-8000-000000000013';
  PERFORM public.activate_customer_booking_transition_email(v_salon,'c5000000-0000-4000-8000-000000000013','reschedule',1,transaction_timestamp());
  v_claim:=public.claim_customer_booking_transition_email(v_salon,'c5000000-0000-4000-8000-000000000013','reschedule',1,v_payload,v_email_hash);
  v_result:=public.complete_customer_booking_transition_email((v_claim->>'outbox_id')::uuid,(v_claim->>'attempt_token')::uuid,'sent','resend-transition-qa',NULL,'none');
  IF v_result->>'status'<>'sent' THEN RAISE EXCEPTION 'valid Resend receipt rejected: %',v_result; END IF;

  -- A→B→A and cancel→undo→cancel use distinct authoritative versions.
  UPDATE public.bookings SET start_time_utc=start_time_utc+interval '1 hour',end_time_utc=end_time_utc+interval '1 hour'
  WHERE id='c5000000-0000-4000-8000-000000000014';
  UPDATE public.bookings SET start_time_utc=start_time_utc-interval '1 hour',end_time_utc=end_time_utc-interval '1 hour'
  WHERE id='c5000000-0000-4000-8000-000000000014';
  IF (SELECT customer_transition_version FROM public.bookings WHERE id='c5000000-0000-4000-8000-000000000014')<>2
     OR (SELECT count(DISTINCT occurrence_key) FROM public.customer_booking_transition_email_outbox
       WHERE booking_id='c5000000-0000-4000-8000-000000000014')<>2 THEN
    RAISE EXCEPTION 'A-B-A occurrence/version collision';
  END IF;
  UPDATE public.bookings SET status='cancelled' WHERE id='c5000000-0000-4000-8000-000000000015';
  v_result:=public.undo_recent_cancelled_booking_v1(
    'c5000000-0000-4000-8000-000000000015',v_salon,
    'c5000000-0000-4000-8000-000000000005','owner'
  );
  IF v_result->>'code'<>'cancel_undone' THEN
    RAISE EXCEPTION 'V1 immediate cancel undo failed: %',v_result;
  END IF;
  UPDATE public.bookings SET status='cancelled' WHERE id='c5000000-0000-4000-8000-000000000015';
  IF (SELECT customer_transition_version FROM public.bookings WHERE id='c5000000-0000-4000-8000-000000000015')<>3
     OR (SELECT array_agg(transition_version ORDER BY transition_version)
       FROM public.customer_booking_transition_email_outbox
       WHERE booking_id='c5000000-0000-4000-8000-000000000015')<>ARRAY[1::bigint,3::bigint] THEN
    RAISE EXCEPTION 'cancel-undo-cancel occurrence/version mismatch';
  END IF;

  -- Missing recipient is durably suppressed; unrelated updates cannot forge input/history.
  UPDATE public.bookings SET status='cancelled' WHERE id='c5000000-0000-4000-8000-000000000016';
  IF NOT EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox
    WHERE booking_id='c5000000-0000-4000-8000-000000000016'
      AND status='suppressed' AND error_code='recipient_missing') THEN
    RAISE EXCEPTION 'missing recipient was not suppressed';
  END IF;
  UPDATE public.bookings SET client_name='Still safe',customer_transition_version=999,
    customer_transition_kind='cancel',customer_transition_email_requested=true,
    customer_transition_email_not_before=transaction_timestamp()
  WHERE id='c5000000-0000-4000-8000-000000000017';
  IF NOT EXISTS(SELECT 1 FROM public.bookings WHERE id='c5000000-0000-4000-8000-000000000017'
    AND customer_transition_version=0 AND customer_transition_kind IS NULL
    AND customer_transition_email_requested=false AND customer_transition_email_not_before IS NULL)
    OR EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox
      WHERE booking_id='c5000000-0000-4000-8000-000000000017') THEN
    RAISE EXCEPTION 'unrelated update forged transition/request';
  END IF;

  -- Stale claimed sends are ambiguous and never reopened.
  UPDATE public.bookings SET start_time_utc=start_time_utc+interval '1 hour',end_time_utc=end_time_utc+interval '1 hour'
  WHERE id='c5000000-0000-4000-8000-000000000018';
  PERFORM public.activate_customer_booking_transition_email(v_salon,'c5000000-0000-4000-8000-000000000018','reschedule',1,transaction_timestamp());
  v_claim:=public.claim_customer_booking_transition_email(v_salon,'c5000000-0000-4000-8000-000000000018','reschedule',1,v_payload,v_email_hash);
  UPDATE public.customer_booking_transition_email_outbox SET updated_at=transaction_timestamp()-interval '16 minutes'
  WHERE id=(v_claim->>'outbox_id')::uuid;
  v_result:=public.reconcile_stale_customer_booking_transition_email_claims(10);
  IF (v_result->>'reconciled')::integer<1 OR NOT EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox
    WHERE id=(v_claim->>'outbox_id')::uuid AND status='unknown' AND next_attempt_at IS NULL) THEN
    RAISE EXCEPTION 'stale sending was not terminal unknown: %',v_result;
  END IF;

  IF EXISTS(SELECT 1 FROM public.customer_booking_transition_email_events
    WHERE row_to_json(customer_booking_transition_email_events)::text ILIKE '%@%'
       OR row_to_json(customer_booking_transition_email_events)::text ILIKE '%resend-transition-qa%') THEN
    RAISE EXCEPTION 'audit event persisted PII/provider receipt';
  END IF;
END;
$behavior$;

-- Customer link wrappers preserve old mutation behavior and activate the exact
-- version in the same transaction.
SET LOCAL ROLE service_role;
SELECT public.cancel_booking_as_customer_with_transition_email(
  'c5000000-0000-4000-8000-000000000119'
) AS cancel_wrapper;
SELECT public.reschedule_booking_as_customer_with_transition_email(
  'c5000000-0000-4000-8000-000000000120',
  transaction_timestamp()+interval '40 days',
  transaction_timestamp()+interval '40 days 45 minutes'
) AS reschedule_wrapper;
RESET ROLE;

DO $wrappers$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox
    WHERE booking_id='c5000000-0000-4000-8000-000000000019'
      AND event_type='cancel' AND transition_version=1 AND status='pending')
  OR NOT EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox
    WHERE booking_id='c5000000-0000-4000-8000-000000000020'
      AND event_type='reschedule' AND transition_version=1 AND status='pending') THEN
    RAISE EXCEPTION 'customer wrapper mutation+activation was not atomic';
  END IF;
END;
$wrappers$;

ROLLBACK;

SELECT 'PASS customer transition email behavior, retry, receipt, lifecycle, wrapper' AS result;
