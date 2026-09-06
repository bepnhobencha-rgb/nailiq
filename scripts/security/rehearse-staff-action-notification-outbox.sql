\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('staff-outbox-qa','Staff outbox QA','Staff outbox QA') ON CONFLICT DO NOTHING;
-- This fixture exercises active delivery materialization, so opt into both
-- channels explicitly instead of relying on the safe defaults for new salons.
INSERT INTO public.salons(
  id,slug,name,phone,salon_phone,timezone,opening_hours,currency_code,
  sms_outbound_enabled,email_outbound_enabled
)
VALUES('d6100000-0000-4000-8000-000000000001','e2e-staff-outbox','E2E Staff Outbox',
  '+16045550100','+16045550100','America/Vancouver',
  '{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}'::jsonb,
  'CAD',true,true);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('d6100000-0000-4000-8000-000000000002','d6100000-0000-4000-8000-000000000001',
  'Outbox service',3500,30,'staff-outbox-qa');
INSERT INTO public.staff(id,salon_id,name,status)
VALUES('d6100000-0000-4000-8000-000000000003','d6100000-0000-4000-8000-000000000001',
  'Outbox staff','active'),
 ('d6100000-0000-4000-8000-000000000004','d6100000-0000-4000-8000-000000000001',
  'Outbox staff two','active');
INSERT INTO auth.users(id,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at)
VALUES('d6100000-0000-4000-8000-000000000005','outbox-desk@nailiq.invalid','',
  transaction_timestamp(),'{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,transaction_timestamp()),
 ('d6100000-0000-4000-8000-000000000006','outbox-desk-two@nailiq.invalid','',
  transaction_timestamp(),'{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,transaction_timestamp());
INSERT INTO public.salon_members(salon_id,user_id,role)
VALUES('d6100000-0000-4000-8000-000000000001',
  'd6100000-0000-4000-8000-000000000005','senior'),
 ('d6100000-0000-4000-8000-000000000001',
  'd6100000-0000-4000-8000-000000000006','senior');

SET LOCAL ROLE service_role;
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,client_email,client_locale,
  start_time_utc,end_time_utc,status,price_cents,
  staff_action_notification_request_id,staff_action_notification_actor_role,
  staff_action_notification_channels,staff_action_notification_delay_seconds
) VALUES(
  'd6100000-0000-4000-8000-000000000010','d6100000-0000-4000-8000-000000000001',
  'd6100000-0000-4000-8000-000000000002','d6100000-0000-4000-8000-000000000003',
  'Outbox Guest','+1 (604) 555-0200','outbox@example.test','vi',
  transaction_timestamp()+interval '3 hours',transaction_timestamp()+interval '3 hours 30 minutes',
  'confirmed',3500,'d6100000-0000-4000-8000-000000000100','system',
  '{"sms":true,"email":true}'::jsonb,0
);
RESET ROLE;

SELECT set_config('request.jwt.claim.role','service_role',true);
DO $behavior$
DECLARE
  v_salon uuid:='d6100000-0000-4000-8000-000000000001';
  v_booking uuid:='d6100000-0000-4000-8000-000000000010';
  v_request uuid:='d6100000-0000-4000-8000-000000000100';
  v_event uuid; v_sms_id uuid; v_email_id uuid; v_token uuid;
  v_sms text; v_email text; v_payload text; v_recipient text; v_result jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.bookings b WHERE b.id=v_booking AND (
    b.staff_action_notification_request_id IS NOT NULL
    OR b.staff_action_notification_actor_role IS NOT NULL
    OR b.staff_action_notification_channels IS NOT NULL
  )) THEN RAISE EXCEPTION 'ephemeral inputs persisted'; END IF;
  SELECT o.id INTO STRICT v_event FROM public.staff_action_notification_outbox o
  WHERE o.salon_id=v_salon AND o.booking_id=v_booking AND o.request_id=v_request
    AND o.event_type='create' AND o.actor_role='system'
    AND o.requested_channels='{"sms":true,"email":true}'::jsonb
    AND o.material_snapshot->>'client_phone'='16045550200'
    AND o.material_snapshot->>'client_email'='outbox@example.test'
    AND o.material_snapshot->>'locale'='vi'
    AND (o.material_snapshot->>'salon_is_test')::boolean;
  SELECT id INTO STRICT v_sms_id FROM public.staff_action_notification_deliveries
    WHERE outbox_id=v_event AND channel='sms' AND status='awaiting_material';
  SELECT id INTO STRICT v_email_id FROM public.staff_action_notification_deliveries
    WHERE outbox_id=v_event AND channel='email' AND status='awaiting_material';

  v_sms:=jsonb_build_object(
    'v',1,'kind','staff_action','channel','sms','salonId',v_salon::text,
    'bookingId',v_booking::text,'event','create','actorUserId',NULL,'actorRole','system',
    'to','+1 (604) 555-0200','body','Lịch hẹn đã được xác nhận.',
    'statusCallbackUrl','https://example.test/twilio/status','salonIsTest',true,'lang','vi'
  )::text;
  v_payload:=encode(extensions.digest(convert_to(v_sms,'UTF8'),'sha256'),'hex');
  v_recipient:=encode(extensions.digest(convert_to('16045550200','UTF8'),'sha256'),'hex');
  v_result:=public.materialize_staff_action_notification_delivery(
    v_sms_id,v_payload,v_recipient,v_sms);
  IF v_result->>'code'<>'materialized' THEN RAISE EXCEPTION 'sms materialize: %',v_result; END IF;
  v_result:=public.materialize_staff_action_notification_delivery(
    v_sms_id,v_payload,v_recipient,v_sms);
  IF v_result->>'code'<>'already_materialized' THEN RAISE EXCEPTION 'sms replay: %',v_result; END IF;

  SELECT value INTO STRICT v_result FROM public.lease_due_staff_action_notification_deliveries(10) q(value)
  WHERE value->>'delivery_id'=v_sms_id::text;
  IF v_result->>'code'<>'delivery_claimed' OR v_result->>'dispatch_envelope'<>v_sms
    OR v_result->>'event_id'<>v_event::text OR v_result->>'envelope_fingerprint' IS NULL THEN
    RAISE EXCEPTION 'sms lease mismatch: %',v_result;
  END IF;
  v_token:=(v_result->>'attempt_token')::uuid;
  v_result:=public.complete_staff_action_notification_delivery(v_sms_id,v_token,'failed',NULL,
    'sms_unavailable_pre_acceptance','retryable_pre_acceptance');
  IF v_result->>'retry_scheduled'<>'true'
    OR NOT EXISTS(SELECT 1 FROM public.staff_action_notification_envelopes WHERE delivery_id=v_sms_id) THEN
    RAISE EXCEPTION 'sms retry classification: %',v_result;
  END IF;
  UPDATE public.staff_action_notification_deliveries SET next_attempt_at=transaction_timestamp()-interval '1 second'
  WHERE id=v_sms_id;
  SELECT value INTO STRICT v_result FROM public.lease_due_staff_action_notification_deliveries(10) q(value)
  WHERE value->>'delivery_id'=v_sms_id::text;
  IF v_result->>'attempt_count'<>'2' OR v_result->>'dispatch_envelope'<>v_sms THEN
    RAISE EXCEPTION 'sms exact retry lease: %',v_result;
  END IF;
  v_token:=(v_result->>'attempt_token')::uuid;
  v_result:=public.complete_staff_action_notification_delivery(v_sms_id,v_token,'sent',
    'SM0123456789abcdef0123456789abcdef',NULL,'none');
  IF v_result->>'status'<>'sent'
    OR EXISTS(SELECT 1 FROM public.staff_action_notification_envelopes WHERE delivery_id=v_sms_id) THEN
    RAISE EXCEPTION 'sms sent cleanup: %',v_result;
  END IF;

  -- A batch lease claims every returned row before an outer SQL filter runs.
  -- Materialize email after SMS is terminal so the test never leases and
  -- discards a sibling channel while selecting only the SMS result.
  v_email:=jsonb_build_object(
    'v',1,'kind','staff_action','channel','email','salonId',v_salon::text,
    'bookingId',v_booking::text,'event','create','actorUserId',NULL,'actorRole','system',
    'to','outbox@example.test','from','NailIQ <booking@example.test>',
    'subject','Booking confirmed','html','<p>Confirmed</p>','text','Confirmed',
    'headers',jsonb_build_object('List-Unsubscribe','<https://example.test/unsubscribe>'),
    'replyTo',NULL
  )::text;
  v_payload:=encode(extensions.digest(convert_to(v_email,'UTF8'),'sha256'),'hex');
  v_recipient:=encode(extensions.digest(convert_to('outbox@example.test','UTF8'),'sha256'),'hex');
  v_result:=public.materialize_staff_action_notification_delivery(
    v_email_id,v_payload,v_recipient,v_email);
  IF v_result->>'code'<>'materialized' THEN RAISE EXCEPTION 'email materialize: %',v_result; END IF;

  SELECT value INTO STRICT v_result FROM public.lease_due_staff_action_notification_deliveries(10) q(value)
  WHERE value->>'delivery_id'=v_email_id::text;
  v_token:=(v_result->>'attempt_token')::uuid;
  v_result:=public.complete_staff_action_notification_delivery(v_email_id,v_token,'unknown',NULL,
    'transport_timeout','none');
  IF v_result->>'status'<>'unknown'
    OR EXISTS(SELECT 1 FROM public.staff_action_notification_envelopes WHERE delivery_id=v_email_id)
    OR EXISTS(SELECT 1 FROM public.staff_action_notification_outbox
      WHERE id=v_event AND material_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'terminal PII cleanup failed: %',v_result;
  END IF;
  IF EXISTS(SELECT 1 FROM public.lease_due_staff_action_notification_deliveries(10) q(value)
    WHERE value->>'delivery_id'=v_email_id::text) THEN
    RAISE EXCEPTION 'unknown outcome was redispatched';
  END IF;
END;$behavior$;
SELECT set_config('request.jwt.claim.role','',true);

-- Atomic reschedule capture and undo cancellation of a queued cancel event.
SELECT set_config('request.jwt.claim.role','service_role',true);
SET LOCAL ROLE service_role;
UPDATE public.bookings SET
  start_time_utc=start_time_utc+interval '1 hour',end_time_utc=end_time_utc+interval '1 hour',
  staff_action_notification_request_id='d6100000-0000-4000-8000-000000000101',
  staff_action_notification_actor_role='system',
  staff_action_notification_channels='{"sms":true,"email":false}'::jsonb,
  staff_action_notification_delay_seconds=5
WHERE id='d6100000-0000-4000-8000-000000000010';
UPDATE public.bookings SET
  status='cancelled',
  staff_action_notification_request_id='d6100000-0000-4000-8000-000000000102',
  staff_action_notification_actor_role='system',
  staff_action_notification_channels='{"sms":true,"email":false}'::jsonb,
  staff_action_notification_delay_seconds=20
WHERE id='d6100000-0000-4000-8000-000000000010';
DO $undo_cancel$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.undo_recent_cancelled_booking_v1(
    'd6100000-0000-4000-8000-000000000010',
    'd6100000-0000-4000-8000-000000000001',
    'd6100000-0000-4000-8000-000000000005','senior'
  );
  IF v_result->>'code'<>'cancel_undone' THEN
    RAISE EXCEPTION 'V1 immediate cancel undo failed: %',v_result;
  END IF;
END;$undo_cancel$;
RESET ROLE;

DO $lifecycle$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.staff_action_notification_outbox
    WHERE request_id='d6100000-0000-4000-8000-000000000101' AND event_type='reschedule') THEN
    RAISE EXCEPTION 'reschedule occurrence not captured';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.staff_action_notification_outbox o
    WHERE o.request_id='d6100000-0000-4000-8000-000000000102' AND o.event_type='cancel'
      AND o.status='cancelled' AND o.material_snapshot IS NULL) THEN
    RAISE EXCEPTION 'undo did not atomically cancel/redact cancel occurrence';
  END IF;
  IF EXISTS(SELECT 1 FROM public.staff_action_notification_deliveries d
    JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
    WHERE o.request_id='d6100000-0000-4000-8000-000000000102'
      AND d.status<>'cancelled') THEN RAISE EXCEPTION 'undo left dispatchable delivery'; END IF;
END;$lifecycle$;

-- Atomic producer wrappers: canonical desk create and whole-party cancel.
SELECT set_config('request.jwt.claim.role','service_role',true);
DO $producers$
DECLARE
  v_salon uuid:='d6100000-0000-4000-8000-000000000001';
  v_service uuid:='d6100000-0000-4000-8000-000000000002';
  v_staff_one uuid:='d6100000-0000-4000-8000-000000000003';
  v_staff_two uuid:='d6100000-0000-4000-8000-000000000004';
  v_actor uuid:='d6100000-0000-4000-8000-000000000005';
  v_actor_two uuid:='d6100000-0000-4000-8000-000000000006';
  v_start timestamptz:=date_trunc('day',transaction_timestamp()+interval '2 days')+interval '12 hours';
  v_quote jsonb; v_result jsonb; v_replay jsonb; v_booking uuid;
  v_group uuid:='d6100000-0000-4000-8000-000000000200';
  v_group_quiet uuid:='d6100000-0000-4000-8000-000000000201';
BEGIN
  v_quote:=public.quote_public_booking(v_salon,v_service,v_staff_one,v_start,
    v_start+interval '40 minutes',ARRAY[]::uuid[],NULL,NULL,
    '+16045550300','create-wrapper@example.test',false);
  IF v_quote->>'code'<>'quoted' THEN RAISE EXCEPTION 'desk create quote: %',v_quote; END IF;
  v_result:=public.create_public_booking_for_desk_with_staff_notification(
    v_salon,v_service,v_staff_one,'Create Wrapper','+16045550300',v_start,
    v_start+interval '40 minutes','confirmed',NULL,ARRAY[]::uuid[],
    'create-wrapper@example.test',NULL,NULL,NULL,false,
    'd6100000-0000-4000-8000-000000000110',v_quote->>'pricing_fingerprint',
    v_actor,true,true,5);
  IF v_result->>'code'<>'booked' OR v_result->'staff_action_notification'->>'code'<>'loaded'
     OR (v_result->'staff_action_notification'->'requested_channels')
        IS DISTINCT FROM '{"sms":true,"email":true}'::jsonb THEN
    RAISE EXCEPTION 'atomic desk create capture: %',v_result;
  END IF;
  v_booking:=(v_result->>'booking_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.staff_action_notification_outbox o
    WHERE o.booking_id=v_booking AND o.request_id='d6100000-0000-4000-8000-000000000110'
      AND o.material_snapshot ? 'pricing_snapshot' AND o.material_snapshot ? 'addons') THEN
    RAISE EXCEPTION 'create material was not finalized atomically';
  END IF;
  v_replay:=public.create_public_booking_for_desk_with_staff_notification(
    v_salon,v_service,v_staff_one,'Create Wrapper','+16045550300',v_start,
    v_start+interval '40 minutes','confirmed',NULL,ARRAY[]::uuid[],
    'create-wrapper@example.test',NULL,NULL,NULL,false,
    'd6100000-0000-4000-8000-000000000110',v_quote->>'pricing_fingerprint',
    v_actor,true,true,5);
  IF v_replay->>'code'<>'booked' OR coalesce((v_replay->>'idempotent')::boolean,false) IS NOT TRUE
     OR v_replay->>'booking_id'<>v_booking::text
     OR (SELECT count(*) FROM public.staff_action_notification_outbox
       WHERE request_id='d6100000-0000-4000-8000-000000000110')<>1 THEN
    RAISE EXCEPTION 'desk create exact replay: %',v_replay;
  END IF;
  v_replay:=public.create_public_booking_for_desk_with_staff_notification(
    v_salon,v_service,v_staff_one,'Create Wrapper','+16045550300',v_start,
    v_start+interval '40 minutes','confirmed',NULL,ARRAY[]::uuid[],
    'create-wrapper@example.test',NULL,NULL,NULL,false,
    'd6100000-0000-4000-8000-000000000110',v_quote->>'pricing_fingerprint',
    v_actor,true,false,5);
  IF v_replay->>'code'<>'idempotency_mismatch' THEN
    RAISE EXCEPTION 'desk create changed channel accepted: %',v_replay;
  END IF;
  v_replay:=public.create_public_booking_for_desk_with_staff_notification(
    v_salon,v_service,v_staff_one,'Create Wrapper','+16045550300',v_start,
    v_start+interval '40 minutes','confirmed',NULL,ARRAY[]::uuid[],
    'create-wrapper@example.test',NULL,NULL,NULL,false,
    'd6100000-0000-4000-8000-000000000110',v_quote->>'pricing_fingerprint',
    v_actor_two,true,true,5);
  IF v_replay->>'code'<>'idempotency_mismatch' THEN
    RAISE EXCEPTION 'desk create changed actor accepted: %',v_replay;
  END IF;

  INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
    client_email,start_time_utc,end_time_utc,status,price_cents,group_id,group_size,
    is_party_member,is_group_organizer)
  VALUES
   ('d6100000-0000-4000-8000-000000000210',v_salon,v_service,v_staff_one,
    'Group Lead','+16045550400','group@example.test',v_start+interval '1 day',
    v_start+interval '1 day 30 minutes','confirmed',3500,v_group,2,true,true),
   ('d6100000-0000-4000-8000-000000000211',v_salon,v_service,v_staff_two,
    'Group Member',NULL,NULL,v_start+interval '1 day',v_start+interval '1 day 30 minutes',
    'confirmed',3500,v_group,2,true,false);
  v_result:=public.cancel_booking_group_for_desk_with_staff_notification(
    v_salon,v_group,'d6100000-0000-4000-8000-000000000120',v_actor,true,true,20);
  IF v_result->>'code'<>'group_cancelled' OR (v_result->>'cancelled_count')::integer<>2
     OR (SELECT count(*) FROM public.bookings WHERE salon_id=v_salon AND group_id=v_group
       AND status='cancelled')<>2
     OR (SELECT count(*) FROM public.staff_action_notification_outbox
       WHERE request_id='d6100000-0000-4000-8000-000000000120')<>1
     OR (SELECT count(*) FROM public.staff_action_notification_deliveries d
       JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
       WHERE o.request_id='d6100000-0000-4000-8000-000000000120')<>2
     OR EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox x
       JOIN public.bookings b ON b.id=x.booking_id WHERE b.group_id=v_group
         AND x.event_type='cancel') THEN
    RAISE EXCEPTION 'atomic group cancel: %',v_result;
  END IF;
  v_replay:=public.cancel_booking_group_for_desk_with_staff_notification(
    v_salon,v_group,'d6100000-0000-4000-8000-000000000120',v_actor,true,true,20);
  IF v_replay->>'code'<>'group_cancelled'
     OR coalesce((v_replay->>'idempotent')::boolean,false) IS NOT TRUE
     OR v_replay->'cancelled_booking_ids' IS DISTINCT FROM v_result->'cancelled_booking_ids' THEN
    RAISE EXCEPTION 'group exact replay: %',v_replay;
  END IF;
  v_replay:=public.cancel_booking_group_for_desk_with_staff_notification(
    v_salon,v_group,'d6100000-0000-4000-8000-000000000120',v_actor,true,false,20);
  IF v_replay->>'code'<>'idempotency_mismatch' THEN
    RAISE EXCEPTION 'group changed channels accepted: %',v_replay;
  END IF;

  INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
    start_time_utc,end_time_utc,status,price_cents,group_id,group_size,
    is_party_member,is_group_organizer)
  VALUES
   ('d6100000-0000-4000-8000-000000000212',v_salon,v_service,v_staff_one,
    'Quiet Lead','+16045550401',v_start+interval '2 days',v_start+interval '2 days 30 minutes',
    'confirmed',3500,v_group_quiet,2,true,true),
   ('d6100000-0000-4000-8000-000000000213',v_salon,v_service,v_staff_two,
    'Quiet Member',NULL,v_start+interval '2 days',v_start+interval '2 days 30 minutes',
    'confirmed',3500,v_group_quiet,2,true,false);
  v_result:=public.cancel_booking_group_for_desk_with_staff_notification(
    v_salon,v_group_quiet,'d6100000-0000-4000-8000-000000000121',v_actor,false,false,20);
  v_replay:=public.cancel_booking_group_for_desk_with_staff_notification(
    v_salon,v_group_quiet,'d6100000-0000-4000-8000-000000000121',v_actor,false,false,20);
  IF v_result->>'code'<>'group_cancelled'
     OR coalesce((v_replay->>'idempotent')::boolean,false) IS NOT TRUE
     OR EXISTS(SELECT 1 FROM public.staff_action_notification_outbox
       WHERE request_id='d6100000-0000-4000-8000-000000000121') THEN
    RAISE EXCEPTION 'quiet group cancel/replay contract: first=% replay=%',v_result,v_replay;
  END IF;

  -- Material that cannot be rendered is terminalized immediately from the
  -- authoritative snapshot; no provider envelope or 30-minute PII wait.
  INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
    start_time_utc,end_time_utc,status,price_cents,
    staff_action_notification_request_id,staff_action_notification_actor_role,
    staff_action_notification_channels,staff_action_notification_delay_seconds)
  VALUES('d6100000-0000-4000-8000-000000000214',v_salon,v_service,v_staff_one,
    'Missing Email','+16045550402',v_start+interval '3 days',v_start+interval '3 days 30 minutes',
    'confirmed',3500,'d6100000-0000-4000-8000-000000000122','system',
    '{"sms":false,"email":true}'::jsonb,5);
  SELECT public.suppress_unmaterializable_staff_action_delivery(d.id,'recipient_missing')
  INTO v_result FROM public.staff_action_notification_deliveries d
  JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
  WHERE o.request_id='d6100000-0000-4000-8000-000000000122';
  IF v_result->>'code'<>'suppressed'
     OR EXISTS(SELECT 1 FROM public.staff_action_notification_outbox
       WHERE request_id='d6100000-0000-4000-8000-000000000122'
         AND material_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'recipient-missing immediate cleanup: %',v_result;
  END IF;
  SELECT public.suppress_unmaterializable_staff_action_delivery(d.id,'recipient_missing')
  INTO v_replay FROM public.staff_action_notification_deliveries d
  JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
  WHERE o.request_id='d6100000-0000-4000-8000-000000000122';
  IF v_replay->>'code'<>'already_suppressed' THEN
    RAISE EXCEPTION 'suppression replay drifted: %',v_replay;
  END IF;

  UPDATE public.salons SET sms_outbound_enabled=false WHERE id=v_salon;
  INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
    start_time_utc,end_time_utc,status,price_cents,
    staff_action_notification_request_id,staff_action_notification_actor_role,
    staff_action_notification_channels,staff_action_notification_delay_seconds)
  VALUES('d6100000-0000-4000-8000-000000000215',v_salon,v_service,v_staff_one,
    'Disabled SMS','+16045550403',v_start+interval '4 days',v_start+interval '4 days 30 minutes',
    'confirmed',3500,'d6100000-0000-4000-8000-000000000123','system',
    '{"sms":true,"email":false}'::jsonb,5);
  SELECT public.suppress_unmaterializable_staff_action_delivery(d.id,'channel_disabled')
  INTO v_result FROM public.staff_action_notification_deliveries d
  JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
  WHERE o.request_id='d6100000-0000-4000-8000-000000000123';
  IF v_result->>'code'<>'suppressed' THEN
    RAISE EXCEPTION 'disabled-channel immediate suppression: %',v_result;
  END IF;
END;$producers$;
SELECT set_config('request.jwt.claim.role','',true);

ROLLBACK;
SELECT 'PASS durable staff-action outbox behavior, producer replay and PII cleanup' AS result;
