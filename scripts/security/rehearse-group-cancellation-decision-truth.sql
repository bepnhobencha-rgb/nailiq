\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('request.jwt.claim.role','service_role',true);

INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('group-cancel-decision-qa','Group cancel QA','Group cancel QA');
INSERT INTO public.salons(
  id,slug,name,phone,salon_phone,timezone,currency_code,
  self_cancel_fee_enabled,self_cancel_window_hours,self_cancel_fee_percent,
  noshow_fee_percent
) VALUES (
  'ca120000-0000-4000-8000-000000000001','group-cancel-decision-qa',
  'Group cancellation decision QA','+16045551200','+16045551200','UTC','CAD',
  true,24,20,20
);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES(
  'ca120000-0000-4000-8000-000000000002',
  'ca120000-0000-4000-8000-000000000001',
  'Synthetic group service',10000,60,'group-cancel-decision-qa'
);
INSERT INTO auth.users(
  id,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at
) VALUES
('ca120000-0000-4000-8000-000000000003','group-owner@nailiq.invalid','',
 transaction_timestamp(),'{}'::jsonb,'{}'::jsonb,transaction_timestamp()),
('ca120000-0000-4000-8000-000000000004','group-reception@nailiq.invalid','',
 transaction_timestamp(),'{}'::jsonb,'{}'::jsonb,transaction_timestamp());
INSERT INTO public.salon_members(salon_id,user_id,role) VALUES
('ca120000-0000-4000-8000-000000000001','ca120000-0000-4000-8000-000000000003','owner'),
('ca120000-0000-4000-8000-000000000001','ca120000-0000-4000-8000-000000000004','receptionist');
INSERT INTO public.staff(id,salon_id,name,status)
SELECT extensions.gen_random_uuid(),'ca120000-0000-4000-8000-000000000001',
  'Synthetic staff '||n,'active'
FROM generate_series(1,14) AS n;

WITH synthetic_staff AS (
  SELECT id,row_number() OVER(ORDER BY id) AS n
  FROM public.staff WHERE salon_id='ca120000-0000-4000-8000-000000000001'
)
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
  start_time_utc,end_time_utc,status,price_cents,group_id,group_size,
  is_party_member,is_group_organizer,booking_channel,noshow_fee_cents,
  noshow_card_id,noshow_card_brand,noshow_card_last4,noshow_consent_at,
  noshow_consent_meta,noshow_charge_status
)
SELECT
  extensions.gen_random_uuid(),'ca120000-0000-4000-8000-000000000001',
  'ca120000-0000-4000-8000-000000000002',s.id,
  CASE WHEN s.n=1 THEN 'Synthetic organizer' ELSE 'Synthetic member '||s.n END,
  CASE WHEN s.n=1 THEN '+16045551201' ELSE NULL END,
  CASE WHEN s.n=1 THEN 'organizer@nailiq.invalid' ELSE NULL END,
  transaction_timestamp()+interval '2 hours',
  transaction_timestamp()+interval '3 hours','confirmed',10000,
  'ca120000-0000-4000-8000-000000000010',12,true,s.n=1,'desk',
  CASE WHEN s.n=1 THEN 20400 ELSE NULL END,
  CASE WHEN s.n=1 THEN 'synthetic-card-token' ELSE NULL END,
  CASE WHEN s.n=1 THEN 'mastercard' ELSE NULL END,
  CASE WHEN s.n=1 THEN '1111' ELSE NULL END,
  CASE WHEN s.n=1 THEN transaction_timestamp() ELSE NULL END,
  CASE WHEN s.n=1 THEN '{"policyVersion":"qa-policy-v1"}'::jsonb ELSE NULL END,
  CASE WHEN s.n=1 THEN 'card_saved' ELSE NULL END
FROM synthetic_staff s WHERE s.n<=12;

WITH synthetic_staff AS (
  SELECT id,row_number() OVER(ORDER BY id) AS n
  FROM public.staff WHERE salon_id='ca120000-0000-4000-8000-000000000001'
)
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
  start_time_utc,end_time_utc,status,price_cents,group_id,group_size,
  is_party_member,is_group_organizer,booking_channel,noshow_fee_cents,
  noshow_card_id,noshow_card_brand,noshow_card_last4,noshow_consent_at,
  noshow_consent_meta,noshow_charge_status
)
SELECT
  extensions.gen_random_uuid(),'ca120000-0000-4000-8000-000000000001',
  'ca120000-0000-4000-8000-000000000002',s.id,
  CASE WHEN s.n=13 THEN 'Waive organizer' ELSE 'Waive member' END,
  CASE WHEN s.n=13 THEN '+16045551202' ELSE NULL END,
  CASE WHEN s.n=13 THEN 'waive@nailiq.invalid' ELSE NULL END,
  transaction_timestamp()+interval '4 hours',
  transaction_timestamp()+interval '5 hours','confirmed',10000,
  'ca120000-0000-4000-8000-000000000020',2,true,s.n=13,'desk',
  CASE WHEN s.n=13 THEN 4000 ELSE NULL END,
  CASE WHEN s.n=13 THEN 'synthetic-waive-card' ELSE NULL END,
  CASE WHEN s.n=13 THEN 'visa' ELSE NULL END,
  CASE WHEN s.n=13 THEN '2222' ELSE NULL END,
  CASE WHEN s.n=13 THEN transaction_timestamp() ELSE NULL END,
  CASE WHEN s.n=13 THEN '{"policyVersion":"qa-policy-v1"}'::jsonb ELSE NULL END,
  CASE WHEN s.n=13 THEN 'card_saved' ELSE NULL END
FROM synthetic_staff s WHERE s.n IN (13,14);

DO $rehearsal$
DECLARE
  v_salon uuid:='ca120000-0000-4000-8000-000000000001';
  v_group uuid:='ca120000-0000-4000-8000-000000000010';
  v_owner uuid:='ca120000-0000-4000-8000-000000000003';
  v_reception uuid:='ca120000-0000-4000-8000-000000000004';
  v_request uuid:='ca120000-0000-4000-8000-000000000011';
  v_approval uuid:='ca120000-0000-4000-8000-000000000012';
  v_waive_group uuid:='ca120000-0000-4000-8000-000000000020';
  v_waive_request uuid:='ca120000-0000-4000-8000-000000000021';
  v_preview jsonb; v_result jsonb; v_review uuid; v_waive_review uuid;
BEGIN
  v_preview:=public.preview_booking_group_cancellation_for_desk(v_salon,v_group,v_reception);
  IF v_preview->>'code'<>'preview_ready'
     OR v_preview->>'group_size'<>'12'
     OR v_preview->>'fee_cents'<>'20400'
     OR v_preview->>'decision_required'<>'true'
     OR v_preview->>'can_waive'<>'false' THEN
    RAISE EXCEPTION 'receptionist preview mismatch: %',v_preview;
  END IF;

  v_result:=public.cancel_booking_group_for_desk_with_decision_truth(
    v_salon,v_group,v_request,v_reception,'not_applicable',true,true,20);
  IF v_result->>'code'<>'fee_decision_required'
     OR (SELECT count(*) FROM public.bookings WHERE group_id=v_group AND status='confirmed')<>12 THEN
    RAISE EXCEPTION 'decision guard did not preserve all 12: %',v_result;
  END IF;

  v_result:=public.cancel_booking_group_for_desk_with_decision_truth(
    v_salon,v_group,v_request,v_reception,'review',true,true,20);
  IF v_result->>'code'<>'group_cancelled'
     OR v_result->>'cancelled_count'<>'12'
     OR v_result->>'fee_state'<>'pending_review'
     OR v_result->>'fee_cents'<>'20400' THEN
    RAISE EXCEPTION 'atomic group cancel mismatch: %',v_result;
  END IF;
  IF (SELECT count(*) FROM public.bookings WHERE group_id=v_group AND status='cancelled')<>12
     OR (SELECT count(*) FROM public.booking_group_cancellation_fee_reviews WHERE group_id=v_group)<>1
     OR (SELECT count(*) FROM public.staff_action_notification_outbox WHERE request_id=v_request)<>1
     OR (SELECT count(*) FROM public.owner_booking_notification_outbox
          WHERE booking_id=(v_result->>'organizer_booking_id')::uuid AND event_type='cancel')<>1
     OR EXISTS(SELECT 1 FROM public.booking_payment_operations
          WHERE booking_id=ANY(ARRAY(SELECT id FROM public.bookings WHERE group_id=v_group))) THEN
    RAISE EXCEPTION 'single truth boundary failed';
  END IF;

  IF public.cancel_booking_group_for_desk_with_decision_truth(
    v_salon,v_group,v_request,v_reception,'review',true,true,20)->>'idempotent'<>'true' THEN
    RAISE EXCEPTION 'cancel replay failed';
  END IF;
  SELECT id INTO STRICT v_review FROM public.booking_group_cancellation_fee_reviews
  WHERE group_id=v_group;
  v_result:=public.decide_group_cancellation_fee_review(
    v_review,v_salon,v_owner,'owner',v_approval,'charge');
  IF v_result->>'state'<>'approved_charge'
     OR v_result->>'payment_status'<>'dispatch_blocked'
     OR (SELECT count(*) FROM public.booking_group_cancellation_fee_approval_receipts
          WHERE review_id=v_review AND action='charge')<>1
     OR EXISTS(SELECT 1 FROM public.booking_payment_operations
          WHERE booking_id=ANY(ARRAY(SELECT id FROM public.bookings WHERE group_id=v_group))) THEN
    RAISE EXCEPTION 'approval truth or provider gate failed: %',v_result;
  END IF;

  v_preview:=public.preview_booking_group_cancellation_for_desk(v_salon,v_waive_group,v_owner);
  IF v_preview->>'decision_required'<>'true' OR v_preview->>'can_waive'<>'true' THEN
    RAISE EXCEPTION 'owner waive preview mismatch: %',v_preview;
  END IF;
  v_result:=public.cancel_booking_group_for_desk_with_decision_truth(
    v_salon,v_waive_group,v_waive_request,v_owner,'waive',false,false,20);
  SELECT id INTO STRICT v_waive_review
  FROM public.booking_group_cancellation_fee_reviews WHERE group_id=v_waive_group;
  IF v_result->>'fee_state'<>'waived'
     OR (SELECT count(*) FROM public.booking_group_cancellation_fee_approval_receipts
          WHERE review_id=v_waive_review AND action='waive'
            AND approval_request_id=v_waive_request)<>1
     OR EXISTS(SELECT 1 FROM public.booking_payment_operations
          WHERE booking_id=ANY(ARRAY(SELECT id FROM public.bookings WHERE group_id=v_waive_group))) THEN
    RAISE EXCEPTION 'direct waive receipt or provider gate failed: %',v_result;
  END IF;
END;
$rehearsal$;

ROLLBACK;
