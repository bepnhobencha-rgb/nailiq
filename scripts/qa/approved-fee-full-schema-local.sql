\set ON_ERROR_STOP on
-- Synthetic SQL receipt simulation only: no provider, network or notifications.
-- Run on the dedicated full-schema local clone; every row rolls back.
BEGIN;
DO $$ BEGIN
 IF current_database() NOT IN ('nailiq_fee_release_full_20260925', 'nailiq_fee_final_acceptance_20260925') THEN
   RAISE EXCEPTION 'dedicated disposable local clone required';
 END IF;
END $$;
SELECT set_config('request.jwt.claim.role','service_role',true);
CREATE TEMP TABLE fee_qa_assertions(message text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.assert_true(ok boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %', message; END IF;
 INSERT INTO fee_qa_assertions VALUES(message);
END $$;
DO $acl$
DECLARE rpc regprocedure;
BEGIN
 FOR rpc IN SELECT unnest(ARRAY[
   'public.discover_due_enabled_booking_payment_reconciliations(text[],integer)'::regprocedure,
   'public.discover_due_ready_fee_payment_reconciliations(uuid[],text[],integer)'::regprocedure,
   'public.record_square_payment_webhook_event_bound(uuid,text,text,timestamptz,text,text,text,text,integer,text,timestamptz,text,text,text,text,text)'::regprocedure,
   'public.record_square_payment_webhook_event(uuid,text,text,timestamptz,text,text,text,text,integer,text,timestamptz,text,text,text,text)'::regprocedure
 ]) LOOP
   PERFORM pg_temp.assert_true(NOT has_function_privilege('anon',rpc,'EXECUTE'),'anon denied '||rpc::text);
   PERFORM pg_temp.assert_true(NOT has_function_privilege('authenticated',rpc,'EXECUTE'),'authenticated denied '||rpc::text);
   PERFORM pg_temp.assert_true(has_function_privilege('service_role',rpc,'EXECUTE'),'service_role allowed '||rpc::text);
 END LOOP;
END;
$acl$;
DO $test$
DECLARE
 salon uuid := 'fa000000-0000-4000-8000-000000000001';
 service uuid := 'fa000000-0000-4000-8000-000000000002';
 staff uuid := 'fa000000-0000-4000-8000-000000000003';
 actor uuid := 'fa000000-0000-4000-8000-000000000004';
 other_salon uuid := 'fa000000-0000-4000-8000-000000000005';
 booking uuid; cap uuid; review uuid; decision uuid; approval uuid; op uuid;
 material jsonb; claim jsonb; result jsonb; meta jsonb; stable jsonb;
 policy text := 'nsp_'||repeat('a',64); stamp timestamptz := transaction_timestamp();
 fee_kind text; i integer; payment text; reference text; refund_prefix text; successor uuid;
BEGIN
 INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES ('e2e-fee-release','Synthetic Fee QA','Synthetic Fee QA');
 INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,payment_provider,feature_flags,
   sms_outbound_enabled,email_outbound_enabled,reminders_enabled)
 VALUES(salon,'e2e-fee-release','E2E Fee release','+16045550101','UTC','CAD','square',
   '{"approved_no_show_charge_dispatch":true,"approved_cancellation_fee_dispatch":true}',false,false,false),
 (other_salon,'e2e-fee-neighbor','E2E Fee neighbor','+16045550102','UTC','CAD','square','{}',false,false,false);
 INSERT INTO public.square_integrations(salon_id,merchant_id,location_id,application_id,environment,enabled)
 VALUES(salon,'qa-merchant','qa-location','qa-application','sandbox',true);
 INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
 VALUES(service,salon,'Synthetic fee service',12500,80,'e2e-fee-release');
 INSERT INTO public.staff(id,salon_id,name,status) VALUES(staff,salon,'Synthetic QA','active');
 INSERT INTO auth.users(id,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at)
 VALUES(actor,'fee-full-schema-preflight-qa@nailiq.invalid','',stamp,'{"provider":"email","providers":["email"]}','{}',stamp);
 INSERT INTO public.salon_members(salon_id,user_id,role) VALUES(salon,actor,'owner');
 FOR i IN 1..4 LOOP
   booking:=gen_random_uuid(); cap:=gen_random_uuid(); review:=gen_random_uuid();
   decision:=gen_random_uuid(); approval:=gen_random_uuid();
   meta:=jsonb_build_object('currency','CAD','scope','booking_member','policyVersion',policy,'feeCents',2500);
   INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,
     status,group_id,noshow_card_required,noshow_card_id,noshow_customer_id,noshow_card_brand,noshow_card_last4,
     noshow_consent_at,noshow_consent_meta,noshow_fee_cents,noshow_charge_status,customer_transition_version,customer_transition_kind)
   VALUES(booking,salon,service,staff,'Synthetic QA','+16045550103',stamp-interval '2 days'+i*interval '3 hours',
     stamp-interval '2 days'+i*interval '3 hours'+interval '80 minutes',CASE WHEN i IN (1,4) THEN 'no_show' ELSE 'cancelled' END,
     CASE WHEN i=3 THEN gen_random_uuid() END,true,'qa-card-'||i,'qa-customer-'||i,'VISA','1111',stamp,meta,2500,'saved',1,'cancel');
   INSERT INTO public.booking_management_action_state(salon_id,booking_id,action) VALUES(salon,booking,'card_manage') ON CONFLICT DO NOTHING;
   INSERT INTO public.booking_management_capabilities(id,salon_id,booking_id,action,scope_kind,epoch,booking_version,
     card_state_fingerprint,expires_at) VALUES(cap,salon,booking,'card_manage','booking_own',1,0,repeat('c',64),stamp+interval '1 day');
   -- Simulate a verified provider save receipt in the disposable DB. This is
   -- NOT evidence of Square Sandbox delivery; that certification is separate.
   INSERT INTO public.booking_card_save_operations(capability_id,salon_id,booking_id,request_id,provider,mode,
     source_fingerprint,initial_card_fingerprint,provider_material,status,attempt_token,provider_reference,
     completion_fingerprint,result_json,completed_at,dispatch_prepared_at,consent_at,consent_meta)
   VALUES(cap,salon,booking,gen_random_uuid(),'square','save_card',repeat('a',64),repeat('b',64),'{}','succeeded',
     gen_random_uuid(),'qa-card-'||i,repeat('d',64),jsonb_build_object('customer_id','qa-customer-'||i,
     'card_brand','VISA','card_last4','1111'),stamp,stamp,stamp,meta);
   PERFORM pg_temp.assert_true((SELECT public.booking_card_protection_state(b)='saved' FROM public.bookings b WHERE id=booking),'synthetic card receipt recognized');
   IF i IN (1,4) THEN
     INSERT INTO public.booking_no_show_decisions(id,salon_id,booking_id,state,original_status,requested_by_user_id,
       requested_by_role,assist_reason_code,requested_at,commit_after,committed_at)
     VALUES(decision,salon,booking,'committed','confirmed',actor,'owner','desk_observation',stamp-interval '2 minutes',stamp-interval '1 minute',stamp);
     result:=public.request_booking_no_show_fee_review(review,decision,salon,actor,'owner');
     PERFORM pg_temp.assert_true(result->>'success'='true','no-show review '||result::text);
     result:=public.decide_booking_no_show_fee_review(review,salon,actor,'owner',approval,'charge');
     PERFORM pg_temp.assert_true(result->>'success'='true','no-show approval '||result::text);
     result:=public.authorize_approved_no_show_fee_dispatch(review,salon,actor,'owner');
     PERFORM pg_temp.assert_true(result->>'success'='true','no-show dispatch authorization '||result::text);
     material:=public.load_booking_payment_operation_material(salon,booking,'noshow_charge',2500);
     PERFORM pg_temp.assert_true(material->>'provider_request_reference'=booking::text,'no-show loaded short reference');
     claim:=public.claim_booking_payment_operation(salon,booking,approval,'noshow_charge',2500,material->>'material_fingerprint');
   ELSE
     fee_kind:=CASE WHEN i=2 THEN 'late' ELSE 'group' END;
     IF i=2 THEN
       INSERT INTO public.booking_late_cancellation_fee_reviews(id,salon_id,booking_id,cancellation_occurrence_version,
         amount_cents,currency,fee_percent,card_brand,card_last4,consent_at,consent_policy_version,policy_snapshot)
       VALUES(review,salon,booking,1,2500,'CAD',20,'VISA','1111',stamp,policy,'{}');
       result:=public.decide_late_cancellation_fee_review(review,salon,actor,'owner',approval,'charge');
     ELSE
       INSERT INTO public.booking_group_cancellation_fee_reviews(id,salon_id,group_id,cancellation_request_id,
         organizer_booking_id,state,amount_cents,currency,card_brand,card_last4,consent_policy_version,policy_snapshot,requested_by_user_id,requested_by_role)
       SELECT review,salon,b.group_id,gen_random_uuid(),booking,'pending_review',2500,'CAD','VISA','1111',policy,'{}',actor,'owner'
         FROM public.bookings b WHERE b.id=booking;
       result:=public.decide_group_cancellation_fee_review(review,salon,actor,'owner',approval,'charge');
     END IF;
     PERFORM pg_temp.assert_true(result->>'success'='true',fee_kind||' approval '||result::text);
     result:=public.claim_approved_cancellation_fee_payment(fee_kind,review,other_salon,actor,'owner');
     PERFORM pg_temp.assert_true(result->>'success'='false','cross-tenant fee rejected');
     claim:=public.claim_approved_cancellation_fee_payment(fee_kind,review,salon,actor,'owner');
   END IF;
   PERFORM pg_temp.assert_true(claim->>'code'='claimed','claim '||i||' '||claim::text);
   PERFORM pg_temp.assert_true(claim->'material'->>'provider_request_reference'=booking::text,'initial claim exact reference');
   op:=(claim->>'operation_id')::uuid;
   SELECT material_json INTO stable FROM public.booking_payment_operations WHERE id=op;
   PERFORM pg_temp.assert_true(stable=claim->'material','initial response equals stored immutable material');
   reference:=booking::text;
   IF i=4 THEN
     -- Model an already-existing pre-marker operation in this synthetic
     -- fixture only. Subsequent production paths must never rewrite it.
     UPDATE public.booking_payment_operations SET material_json=material_json-'provider_request_reference'
       WHERE id=op;
     SELECT material_json INTO stable FROM public.booking_payment_operations WHERE id=op;
     reference:='booking:'||booking::text;
   END IF;
   result:=public.complete_booking_payment_operation(op,(claim->>'attempt_token')::uuid,'unknown',NULL,NULL,NULL,'provider_transport_error');
   PERFORM pg_temp.assert_true(result->>'code'='provider_outcome_unknown' AND
     (SELECT status='unknown' FROM public.booking_payment_operations WHERE id=op),'unknown persisted '||result::text);
   UPDATE public.booking_payment_operations SET next_reconcile_at=stamp-interval '1 minute' WHERE id=op;
   IF i < 4 THEN
     PERFORM pg_temp.assert_true((SELECT count(*)=0 FROM public.discover_due_ready_fee_payment_reconciliations(
       NULL::uuid[],ARRAY['noshow_charge','late_cancel_charge'],25)), 'null ready set never claims');
     PERFORM pg_temp.assert_true((SELECT count(*)=0 FROM public.discover_due_ready_fee_payment_reconciliations(
       '{}'::uuid[],ARRAY['noshow_charge','late_cancel_charge'],25)), 'empty ready set never claims');
     -- Simulate repeated configuration outages: no ready provider means no
     -- attempt, lease, error-history or immutable material change.
     FOR j IN 1..5 LOOP
       PERFORM public.discover_due_ready_fee_payment_reconciliations(
         '{}'::uuid[],ARRAY['noshow_charge','late_cancel_charge'],25);
     END LOOP;
     PERFORM pg_temp.assert_true((SELECT status='unknown' AND attempt_count=1
       AND attempt_token IS NULL AND material_json=stable AND error_code='provider_transport_error'
       FROM public.booking_payment_operations WHERE id=op), 'five config outages preserve operation');
     PERFORM pg_temp.assert_true((SELECT count(*)=0 FROM public.discover_due_ready_fee_payment_reconciliations(
       ARRAY[op],ARRAY[CASE WHEN i=1 THEN 'late_cancel_charge' ELSE 'noshow_charge' END],25)),
       'ready ID outside enabled kind is not claimed');
     SELECT value INTO result FROM public.discover_due_ready_fee_payment_reconciliations(
       ARRAY[op],ARRAY[CASE WHEN i=1 THEN 'noshow_charge' ELSE 'late_cancel_charge' END],25)
       value WHERE value->>'operation_id'=op::text;
   ELSE
     -- Retain compatibility coverage for an existing operation and old worker.
     SELECT value INTO result FROM public.discover_due_enabled_booking_payment_reconciliations(
       ARRAY['noshow_charge'],25) value WHERE value->>'operation_id'=op::text;
   END IF;
   PERFORM pg_temp.assert_true(result->>'code'='reconcile_claimed','reconciliation claimed');
   PERFORM pg_temp.assert_true(result->'material'=stable,'reconciliation exact stored reference/material');
   payment:='qa-payment-'||i;
   result:=public.record_square_payment_webhook_event_bound(salon,'qa-missing-customer-'||i,'payment.updated',stamp,
     repeat('f',64),payment,'qa-location','COMPLETED',2500,'CAD',stamp,reference,'qa-merchant','qa-application','sandbox',NULL);
   PERFORM pg_temp.assert_true(result->>'success'='false','missing customer rejected');
   result:=public.record_square_payment_webhook_event_bound(salon,'qa-wrong-customer-'||i,'payment.updated',stamp,
     repeat('f',64),payment,'qa-location','COMPLETED',2500,'CAD',stamp,reference,'qa-merchant','qa-application','sandbox','qa-different-customer');
   PERFORM pg_temp.assert_true(result->>'success'='false','wrong customer rejected');
   result:=public.record_square_payment_webhook_event(salon,'qa-legacy-wrapper-'||i,'payment.updated',stamp,
     repeat('f',64),payment,'qa-location','COMPLETED',2500,'CAD',stamp,reference,'qa-merchant','qa-application','sandbox');
   PERFORM pg_temp.assert_true(result->>'success'='false','old unbound wrapper rejects fees');
   PERFORM pg_temp.assert_true((SELECT status='reconciling' AND provider_payment_id IS NULL FROM public.booking_payment_operations WHERE id=op),'customer mismatch cannot complete original');
   result:=public.record_square_payment_webhook_event_bound(other_salon,'qa-other-'||i,'payment.updated',stamp,repeat('f',64),payment,
     'qa-location','COMPLETED',2500,'CAD',stamp,reference,'qa-merchant','qa-application','sandbox','qa-customer-'||i);
   PERFORM pg_temp.assert_true(result->>'code'='provider_context_mismatch','cross-tenant webhook rejected');
   PERFORM pg_temp.assert_true((SELECT status='reconciling' AND provider_payment_id IS NULL FROM public.booking_payment_operations WHERE id=op),'cross-tenant webhook did not complete original');
   IF i=2 THEN
     result:=public.complete_booking_payment_operation(op,(result->>'attempt_token')::uuid,'succeeded','COMPLETED',payment,NULL,NULL);
     -- Intentionally missing lease token must fail without projecting money.
     PERFORM pg_temp.assert_true(result->>'success'='false','invalid completion lease rejected');
     SELECT attempt_token INTO cap FROM public.booking_payment_operations WHERE id=op;
     result:=public.complete_booking_payment_operation(op,cap,'succeeded','COMPLETED',payment,NULL,NULL);
     PERFORM pg_temp.assert_true(result->>'code'='succeeded','synchronous cancellation completion '||result::text);
   END IF;
   -- Wrong amount must not consume the intended operation or report success.
   result:=public.record_square_payment_webhook_event_bound(salon,'qa-wrong-'||i,'payment.updated',stamp,repeat('e',64),payment,
     'qa-location','COMPLETED',2501,'CAD',stamp,reference,'qa-merchant','qa-application','sandbox','qa-customer-'||i);
   PERFORM pg_temp.assert_true(result->>'success'='false','wrong amount webhook denied');
   result:=public.record_square_payment_webhook_event_bound(salon,'qa-paid-'||i,'payment.updated',stamp,repeat('f',64),payment,
     'qa-location','COMPLETED',2500,'CAD',stamp,reference,'qa-merchant','qa-application','sandbox','qa-customer-'||i);
   PERFORM pg_temp.assert_true(result->>'code'='payment_applied','webhook applies short reference '||i||' '||result::text);
   PERFORM pg_temp.assert_true((SELECT status='succeeded' AND provider_payment_id=payment AND material_json=stable FROM public.booking_payment_operations WHERE id=op),'durable exact payment');
   IF i IN (1,4) THEN
     PERFORM pg_temp.assert_true((SELECT noshow_charge_status='charged' AND noshow_payment_id=payment FROM public.bookings WHERE id=booking),'no-show booking paid');
   ELSE
     PERFORM pg_temp.assert_true((SELECT late_cancel_charge_status='charged' AND late_cancel_payment_id=payment FROM public.bookings WHERE id=booking),'cancellation booking paid');
   END IF;
   result:=public.record_square_payment_webhook_event_bound(salon,'qa-paid-'||i,'payment.updated',stamp,repeat('f',64),payment,
     'qa-location','COMPLETED',2500,'CAD',stamp,reference,'qa-merchant','qa-application','sandbox','qa-customer-'||i);
   PERFORM pg_temp.assert_true(result->>'code'='event_replay','webhook replay idempotent');
   result:=public.record_square_payment_webhook_event_bound(salon,'qa-paid-'||i,'payment.updated',stamp,repeat('f',64),payment,
     'qa-location','COMPLETED',2500,'CAD',stamp,reference,'qa-merchant','qa-application','sandbox','qa-different-customer');
   PERFORM pg_temp.assert_true(result->>'success'='false','same event wrong customer cannot bypass binding via replay');
   PERFORM pg_temp.assert_true((SELECT status='succeeded' AND provider_payment_id=payment AND material_json=stable
     FROM public.booking_payment_operations WHERE id=op),'wrong customer replay cannot mutate paid operation');
   refund_prefix:=CASE WHEN i IN (1,4) THEN 'noshow' ELSE 'late_cancel' END;
   IF i IN (1,2,3,4) THEN
     -- Partial then full refund each followed by a DISTINCT newer payment
     -- event must retain refund truth, not reset the booking to charged.
     FOR decision IN SELECT x FROM unnest(ARRAY[gen_random_uuid(),gen_random_uuid()]) x LOOP
       IF i IN (1,4) THEN
         material:=public.load_booking_payment_operation_material(salon,booking,'noshow_refund',1250);
         claim:=public.claim_booking_payment_operation(salon,booking,decision,'noshow_refund',1250,material->>'material_fingerprint');
       ELSE
         material:=public.load_late_cancel_refund_material(op,1250);
         claim:=public.claim_late_cancel_refund(op,decision,1250,material->>'material_fingerprint');
       END IF;
       PERFORM pg_temp.assert_true(claim->>'code'='claimed','refund claim '||claim::text);
       result:=public.complete_booking_payment_operation((claim->>'operation_id')::uuid,
         (claim->>'attempt_token')::uuid,'succeeded','COMPLETED',NULL,'qa-refund-'||decision::text,NULL);
       PERFORM pg_temp.assert_true(result->>'code'='succeeded','refund completed '||result::text);
       SELECT to_jsonb(b) INTO material FROM public.bookings b WHERE id=booking;
       result:=public.record_square_payment_webhook_event_bound(salon,'qa-paid-after-refund-'||decision::text,'payment.updated',
         stamp+interval '2 minutes',repeat('f',64),payment,'qa-location','COMPLETED',2500,'CAD',
         stamp+interval '2 minutes',reference,'qa-merchant','qa-application','sandbox','qa-customer-'||i);
       PERFORM pg_temp.assert_true(result->>'code'='payment_applied','later completed event accepted');
       PERFORM pg_temp.assert_true((SELECT to_jsonb(b)->>(refund_prefix||'_refunded_cents')=material->>(refund_prefix||'_refunded_cents')
         AND to_jsonb(b)->>(refund_prefix||'_refund_status')=material->>(refund_prefix||'_refund_status')
         AND to_jsonb(b)->>(refund_prefix||'_charge_status')=material->>(refund_prefix||'_charge_status')
         FROM public.bookings b WHERE id=booking),'new completed event preserves partial/full refund');
     END LOOP;
   END IF;
   IF i IN (2,3) THEN
     -- Simulate an already-successful later cancellation occurrence. Normal
     -- booking terminal-state rules currently prevent initiating this via UI;
     -- historical/future ledger revisions must still resist stale webhooks.
     successor:=gen_random_uuid();
     INSERT INTO public.booking_payment_operations(id,salon_id,booking_id,request_id,operation_kind,
       operation_occurrence_version,provider,provider_account_fingerprint,amount_cents,currency,
       material_fingerprint,material_json,provider_material,provider_idempotency_key,status,
       provider_payment_id,provider_status,result_json,completed_at)
     SELECT successor,o.salon_id,o.booking_id,gen_random_uuid(),o.operation_kind,2,o.provider,
       o.provider_account_fingerprint,o.amount_cents,o.currency,repeat('9',64),
       jsonb_set(o.material_json,'{operation_occurrence_version}','2'),o.provider_material,
       'nq:'||successor::text,'succeeded','qa-newer-'||i,'COMPLETED',
       jsonb_build_object('provider_payment_id','qa-newer-'||i),stamp FROM public.booking_payment_operations o WHERE o.id=op;
     UPDATE public.bookings SET late_cancel_charge_status='charged',late_cancel_payment_id='qa-newer-'||i,
       late_cancel_charge_occurrence_version=2,late_cancel_refunded_cents=0,late_cancel_refund_status='none' WHERE id=booking;
     result:=public.record_square_payment_webhook_event_bound(salon,'qa-older-occurrence-'||i,'payment.updated',
       stamp+interval '3 minutes',repeat('f',64),payment,'qa-location','COMPLETED',2500,'CAD',
       stamp+interval '3 minutes',reference,'qa-merchant','qa-application','sandbox','qa-customer-'||i);
     PERFORM pg_temp.assert_true(result->>'code'='payment_applied','old occurrence ledger receipt accepted');
     PERFORM pg_temp.assert_true((SELECT late_cancel_payment_id='qa-newer-'||i AND late_cancel_charge_occurrence_version=2
       AND late_cancel_charge_status='charged' AND late_cancel_refunded_cents=0 AND late_cancel_refund_status='none'
       FROM public.bookings WHERE id=booking),'old occurrence cannot overwrite newer booking financial projection');
   END IF;
   RAISE NOTICE 'PASS approved fee kind %: approval, exact claim, unknown, reconciliation, webhook, replay',i;
 END LOOP;
END;
$test$;
SELECT count(*) AS passed_assertions FROM fee_qa_assertions;
ROLLBACK;
