\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
CREATE FUNCTION pg_temp.check_legacy(p_ok boolean,p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',p_label; END IF; END; $$;
INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('legacy-card-qa','Legacy QA','Legacy QA') ON CONFLICT DO NOTHING;
INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,cancellation_policy,self_cancel_fee_enabled,self_cancel_window_hours,self_cancel_fee_percent)
VALUES('55650000-0000-4000-8000-000000000001','legacy-card-qa','Synthetic Legacy QA','+16045550109','UTC','CAD',
 '{"en":"Cancel with 24 hours notice.","vi":"Báo trước 24 giờ khi hủy."}',true,24,20),
 ('55650000-0000-4000-8000-000000000004','legacy-card-other-qa','Other Synthetic QA','+16045550108','UTC','CAD',NULL,false,24,20);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('55650000-0000-4000-8000-000000000002','55650000-0000-4000-8000-000000000001','Synthetic Service',5000,30,'legacy-card-qa');
INSERT INTO public.staff(id,salon_id,name,status) VALUES('55650000-0000-4000-8000-000000000003','55650000-0000-4000-8000-000000000001','QA Staff','active');
INSERT INTO public.square_integrations(salon_id,merchant_id,location_id,application_id,access_token,environment,enabled)
VALUES('55650000-0000-4000-8000-000000000001','merchant_qa','location_qa','application_qa','synthetic-not-usable','sandbox',true);
INSERT INTO auth.users(id,email) VALUES('55650000-0000-4000-8000-000000000010','legacy-owner@example.test');
INSERT INTO public.salon_members(salon_id,user_id,role) VALUES('55650000-0000-4000-8000-000000000001','55650000-0000-4000-8000-000000000010','owner');
DO $$
DECLARE salon uuid:='55650000-0000-4000-8000-000000000001'; booking uuid; cap uuid; receipt jsonb; snapshot jsonb;
 result jsonb; meta jsonb; i integer; read_at timestamptz; clock_at timestamptz:=transaction_timestamp();
 row_booking public.bookings%ROWTYPE; row_salon public.salons%ROWTYPE; old_op uuid; n integer;
BEGIN
 SELECT * INTO row_salon FROM public.salons WHERE id=salon;
 FOR i IN 1..18 LOOP
   booking:=('55650000-0000-4000-8000-'||lpad((100+i)::text,12,'0'))::uuid;
   INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,start_time_utc,end_time_utc,status,
     price_cents,noshow_card_required,noshow_fee_cents,noshow_card_id,noshow_customer_id,noshow_card_brand,noshow_card_last4,noshow_consent_at,noshow_consent_meta)
   VALUES(booking,salon,'55650000-0000-4000-8000-000000000002','55650000-0000-4000-8000-000000000003','Synthetic Guest',
     date_trunc('hour',clock_at)+make_interval(days=>3,hours=>i),date_trunc('hour',clock_at)+make_interval(days=>3,hours=>i,mins=>30),
     'confirmed',5000,true,1000,'card_qa','customer_qa','VISA','4242',clock_at-interval '1 day','{"source":"legacy"}');
   cap:=(public.mint_booking_management_capability(salon,booking,'card_manage',clock_at+interval '25 minutes')->>'token_id')::uuid;
   PERFORM pg_temp.check_legacy(cap IS NOT NULL,'valid recovery capability');
   IF i IN (2,11,18) THEN
     old_op:=extensions.gen_random_uuid();
     INSERT INTO public.booking_card_save_operations(id,capability_id,salon_id,booking_id,request_id,provider,mode,
       source_fingerprint,initial_card_fingerprint,provider_material,status,attempt_token,provider_reference,
       completion_fingerprint,result_json,completed_at,error_code,delivery_version)
     VALUES(old_op,cap,salon,booking,extensions.gen_random_uuid(),'square','save_card',repeat('a',64),repeat('a',64),'{}',
       CASE WHEN i=11 THEN 'unknown' WHEN i=18 THEN 'failed' ELSE 'succeeded' END,extensions.gen_random_uuid(),
       CASE WHEN i=2 THEN 'card_qa' END,repeat('b',64),'{"code":"legacy_result"}',clock_at,
       CASE WHEN i<>2 THEN 'provider_exception' END,NULL);
   END IF;
   result:=public.inspect_booking_card_recovery(cap);
   PERFORM pg_temp.check_legacy(result->>'can_retry'='false','existing card never unlocks new capture');
   PERFORM pg_temp.check_legacy((result->>'can_verify_existing_card')::boolean=(i<>11),'unknown fenced from legacy read completion');
   SELECT * INTO row_booking FROM public.bookings WHERE id=booking;
   PERFORM pg_temp.check_legacy(public.booking_card_protection_state(row_booking)<>'saved','legacy is unprotected');
   result:=public.booking_late_cancellation_snapshot(row_booking,row_salon,clock_at);
   PERFORM pg_temp.check_legacy(result->>'has_chargeable_card'='false','legacy card cannot be charged');
   snapshot:=public.booking_legacy_card_snapshot(row_booking);
   meta:=jsonb_build_object('v',2,'source','legacy_card_fresh_consent','receiptSource','existing_card_read',
     'policyVersion','nsp_'||repeat('a',64),'feeCents',1000,'currency','CAD','scope','booking_member',
     'policyEn','Cancel with 24 hours notice.','policyVi','Báo trước 24 giờ khi hủy.');
   receipt:='{"card_id":"card_qa","customer_id":"customer_qa","merchant_id":"merchant_qa","environment":"sandbox","card_brand":"VISA","card_last4":"4242","enabled":true}';
   read_at:=clock_at;
   IF i=3 THEN receipt:=receipt-'card_brand';
   ELSIF i=4 THEN receipt:=receipt||'{"enabled":false}';
   ELSIF i=5 THEN receipt:=receipt||'{"customer_id":"foreign_customer"}';
   ELSIF i=6 THEN receipt:=receipt||'{"merchant_id":"foreign_merchant"}';
   ELSIF i=7 THEN read_at:=clock_at-interval '3 minutes';
   ELSIF i=8 THEN UPDATE public.booking_management_capabilities SET expires_at=clock_at-interval '1 second' WHERE id=cap;
   ELSIF i=9 THEN UPDATE public.bookings SET noshow_fee_cents=2000 WHERE id=booking;
   ELSIF i=10 THEN UPDATE public.salons SET cancellation_policy='{"en":"Changed","vi":"Thay đổi"}' WHERE id=salon;
   ELSIF i=12 THEN UPDATE public.booking_management_capabilities SET revoked_at=clock_at,revoke_reason='manual_revoke' WHERE id=cap;
   ELSIF i=13 THEN meta:=meta-'policyVersion';
   ELSIF i=14 THEN UPDATE public.bookings SET status='cancelled' WHERE id=booking;
   ELSIF i=15 THEN UPDATE public.bookings SET start_time_utc=start_time_utc+interval '1 minute' WHERE id=booking;
   ELSIF i=16 THEN receipt:=receipt||'{"card_id":"wrong_card"}';
   ELSIF i=17 THEN receipt:=receipt||'{"environment":"production"}'; END IF;
   result:=public.confirm_booking_legacy_card_verification(cap,snapshot,receipt,read_at,meta);
   IF i IN (1,2,18) THEN
     PERFORM pg_temp.check_legacy(result->>'ok'='true','exact enabled read and fresh consent saved');
     result:=public.confirm_booking_legacy_card_verification(cap,snapshot,receipt,read_at,meta);
     PERFORM pg_temp.check_legacy(result->>'ok'='true' AND result->>'idempotent'='true','completion replay idempotent');
     PERFORM pg_temp.check_legacy((SELECT count(*)=1 FROM public.booking_card_save_operations WHERE booking_id=booking AND delivery_version=2),'one new durable receipt');
     PERFORM pg_temp.check_legacy((SELECT dispatch_prepared_at IS NULL AND card_dispatch_bound_at IS NULL FROM public.booking_card_save_operations
       WHERE booking_id=booking AND delivery_version=2),'read receipt never fabricated a CreateCard dispatch');
     PERFORM pg_temp.check_legacy((SELECT card_protection_status='saved' AND noshow_card_id='card_qa' AND noshow_customer_id='customer_qa'
       AND status='confirmed' AND noshow_consent_meta=meta FROM public.bookings WHERE id=booking),'preserve binding and reservation; activate only after consent');
     PERFORM pg_temp.check_legacy((public.inspect_booking_card_recovery(cap)->>'protection_status')='saved','original link reload sees saved');
   ELSE
     PERFORM pg_temp.check_legacy(result->>'ok'='false','invalid or stale read remains unprotected');
     PERFORM pg_temp.check_legacy((SELECT count(*)=0 FROM public.booking_card_save_operations WHERE booking_id=booking AND delivery_version=2),'rejected read creates no save operation');
   END IF;
   IF i=10 THEN UPDATE public.salons SET cancellation_policy=row_salon.cancellation_policy WHERE id=salon; END IF;
   IF i=1 THEN
     result:=public.mark_booking_card_protection_reviewed(booking,'55650000-0000-4000-8000-000000000004','55650000-0000-4000-8000-000000000010');
     PERFORM pg_temp.check_legacy(result->>'ok'='false','owner cannot review foreign salon');
   ELSIF i=3 THEN
     result:=public.mark_booking_card_protection_reviewed(booking,salon,'55650000-0000-4000-8000-000000000010');
     PERFORM pg_temp.check_legacy(result->>'ok'='true','owner review works without a save operation');
     PERFORM pg_temp.check_legacy((SELECT card_protection_status='manual_review' AND card_protection_reviewed_at IS NOT NULL FROM public.bookings WHERE id=booking),'review is not protection');
     result:=public.record_booking_legacy_card_check(cap,extensions.gen_random_uuid(),'reconciliation','reconciliation_read_failed',504,'{}','{}','read_failed');
     PERFORM pg_temp.check_legacy(result->>'ok'='true','GET timeout recorded as read failure');
     result:=public.record_booking_legacy_card_check(cap,extensions.gen_random_uuid(),'reconciliation','reconciliation_read_failed',404,ARRAY['PRIVATE_EMAIL'],'{}','read_failed');
     PERFORM pg_temp.check_legacy(result->>'ok'='false','unknown provider details rejected');
     PERFORM pg_temp.check_legacy((SELECT count(*)=1 FROM public.booking_legacy_card_checks WHERE booking_id=booking),'diagnostic history retained safely');
   END IF;
 END LOOP;
 PERFORM pg_temp.check_legacy(NOT has_function_privilege('anon','public.confirm_booking_legacy_card_verification(uuid,jsonb,jsonb,timestamptz,jsonb)','EXECUTE'),'anonymous completion denied');
 PERFORM pg_temp.check_legacy(NOT has_function_privilege('authenticated','public.inspect_booking_legacy_card(uuid)','EXECUTE'),'customer cannot read raw binding');
 PERFORM pg_temp.check_legacy(NOT has_table_privilege('authenticated','public.booking_legacy_card_checks','SELECT'),'diagnostic tenant data private');
 PERFORM pg_temp.check_legacy(NOT has_function_privilege('service_role','public.booking_legacy_card_snapshot(public.bookings)','EXECUTE'),'private snapshot helper unexposed');
 RAISE NOTICE 'PASS: 18 legacy scenarios, replay, consent, snapshot fences, review, diagnostics and private ACL';
END; $$;
ROLLBACK;
