\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('payment-rollback-qa','Payment rollback QA','Payment rollback QA');
INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code)
VALUES('15150000-0000-4000-8000-000000009001','payment-rollback-qa',
  'Payment rollback QA','+16045559001','UTC','CAD');
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('15150000-0000-4000-8000-000000009002',
  '15150000-0000-4000-8000-000000009001','Payment rollback',1000,30,'payment-rollback-qa');
INSERT INTO public.staff(id,salon_id,name,status)
VALUES('15150000-0000-4000-8000-000000009003',
  '15150000-0000-4000-8000-000000009001','Payment rollback','active');
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status
) VALUES (
  '15150000-0000-4000-8000-000000009004',
  '15150000-0000-4000-8000-000000009001',
  '15150000-0000-4000-8000-000000009002',
  '15150000-0000-4000-8000-000000009003','Payment rollback','+16045559004',
  now()+interval '2 days',now()+interval '2 days 30 minutes','cancelled'
);
INSERT INTO public.booking_payment_operations(
  id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,
  amount_cents,currency,material_fingerprint,material_json,provider_material,
  public_request_fingerprint,booking_create_fingerprint,delivery_mode,
  provider_order_id,provider_link_id,provider_link_url,
  public_square_capability_token_hash,public_square_capability_expires_at,
  booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,
  start_time_utc,end_time_utc,client_phone_fingerprint,provider_idempotency_key
) VALUES (
  '15150000-0000-4000-8000-000000009010',
  '15150000-0000-4000-8000-000000009001',gen_random_uuid(),'deposit_charge',
  'square',repeat('a',64),1000,'CAD',repeat('b',64),'{}',
  jsonb_build_object('provider_environment','sandbox'),
  repeat('e',64),repeat('f',64),'public_customer_present',
  'order_rollback','link_rollback','https://square.example.test/pay/rollback',
  repeat('9',64),now()+interval '15 minutes',gen_random_uuid(),
  repeat('c',64),'15150000-0000-4000-8000-000000009002',
  '15150000-0000-4000-8000-000000009003',now()+interval '2 days',
  now()+interval '2 days 30 minutes',repeat('d',64),
  'nq:15150000-0000-4000-8000-000000009010'
);
INSERT INTO public.booking_cancel_deposit_refund_sagas(
  salon_id,booking_id,request_id,requested_amount_cents,refund_operation_id,
  refund_material_fingerprint,status,cancellation_transition_version,
  cancellation_result,result_json
) VALUES (
  '15150000-0000-4000-8000-000000009001',
  '15150000-0000-4000-8000-000000009004',gen_random_uuid(),1000,
  '15150000-0000-4000-8000-000000009010',repeat('b',64),'refund_claimed',1,
  jsonb_build_object('status','cancelled'),jsonb_build_object('refund_status','sending')
);
ROLLBACK;

DO $verify$
BEGIN
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE id='15150000-0000-4000-8000-000000009010')
     OR EXISTS(SELECT 1 FROM public.booking_cancel_deposit_refund_sagas
    WHERE salon_id='15150000-0000-4000-8000-000000009001')
     OR EXISTS(SELECT 1 FROM public.salons
    WHERE id='15150000-0000-4000-8000-000000009001') THEN
    RAISE EXCEPTION 'payment rollback left business rows';
  END IF;
END
$verify$;
SELECT 'booking payment rollback rehearsal passed' AS result;
