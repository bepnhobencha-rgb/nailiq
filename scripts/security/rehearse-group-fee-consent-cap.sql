-- Local disposable QA only; synthetic data; no provider transport. Every change rolls back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
DO $$ BEGIN IF current_setting('nailiq.qa_disposable',true) IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'local disposable QA only'; END IF; END $$;
SELECT set_config('request.jwt.claim.role','service_role',true);
CREATE FUNCTION pg_temp.assert_true(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; RAISE NOTICE 'PASS %',label; END $$;
CREATE TEMP TABLE group_fee_probe(cap uuid, cancel_result jsonb);
DO $seed$
DECLARE salon uuid:='fc260926-0000-4000-8000-000000000001'; service uuid:='fc260926-0000-4000-8000-000000000002'; staff uuid:='fc260926-0000-4000-8000-000000000003'; actor uuid:='fc260926-0000-4000-8000-000000000004'; organizer uuid:='fc260926-0000-4000-8000-000000000010'; member uuid:='fc260926-0000-4000-8000-000000000011'; grp uuid:='fc260926-0000-4000-8000-000000000099'; cap uuid:=gen_random_uuid(); policy text:='nsp_'||repeat('a',64); meta jsonb; result jsonb;
BEGIN
 INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('e2e-public-group-fee-gap','Synthetic Group Fee','Synthetic Group Fee');
 INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,payment_provider,feature_flags,sms_outbound_enabled,email_outbound_enabled,reminders_enabled,self_cancel_fee_enabled,self_cancel_window_hours,self_cancel_fee_percent,noshow_fee_percent)
 VALUES(salon,'e2e-public-group-fee-gap','E2E public group fee gap','+16045550101','UTC','CAD','square','{}',false,false,false,true,24,20,20);
 INSERT INTO public.square_integrations(salon_id,merchant_id,location_id,application_id,environment,enabled) VALUES(salon,'qa-merchant','qa-location','qa-application','sandbox',true);
 INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category) VALUES(service,salon,'Synthetic group fee service',12500,80,'e2e-public-group-fee-gap');
 INSERT INTO public.staff(id,salon_id,name,status) VALUES(staff,salon,'Synthetic QA','active');
 INSERT INTO auth.users(id,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at) VALUES(actor,'group-fee-gap@nailiq.invalid','',now(),'{}','{}',now());
 INSERT INTO public.salon_members(salon_id,user_id,role) VALUES(salon,actor,'owner');
 meta:=jsonb_build_object('currency','CAD','scope','whole_party','policyVersion',policy,'feeCents',5000,'policyEn','Synthetic whole party consent','policyVi','Synthetic whole party consent');
 INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,created_at,price_cents,group_id,group_size,is_party_member,is_group_organizer,noshow_card_required,noshow_card_id,noshow_customer_id,noshow_card_brand,noshow_card_last4,noshow_consent_at,noshow_consent_meta,noshow_fee_cents,noshow_charge_status)
 VALUES(organizer,salon,service,staff,'Synthetic Organizer','+16045550103',now()+interval '3 hours',now()+interval '4 hours 20 minutes','confirmed',now()-interval '2 days',12500,grp,2,true,true,true,'qa-group-card','qa-group-customer','VISA','1111',now(),meta,5000,'saved'),
 (member,salon,service,staff,'Synthetic Member','+16045550104',now()+interval '5 hours',now()+interval '6 hours 20 minutes','confirmed',now()-interval '2 days',12500,grp,2,true,false,false,null,null,null,null,null,null,null,null);
 INSERT INTO public.booking_management_action_state(salon_id,booking_id,action) VALUES(salon,organizer,'card_manage') ON CONFLICT DO NOTHING;
 INSERT INTO public.booking_management_capabilities(id,salon_id,booking_id,action,scope_kind,epoch,booking_version,card_state_fingerprint,expires_at) VALUES(cap,salon,organizer,'card_manage','organizer_own',1,0,repeat('c',64),now()+interval '20 minutes');
 INSERT INTO public.booking_card_save_operations(capability_id,salon_id,booking_id,request_id,provider,mode,source_fingerprint,initial_card_fingerprint,provider_material,status,attempt_token,provider_reference,completion_fingerprint,result_json,completed_at,dispatch_prepared_at,consent_at,consent_meta,expected_customer_id,expected_merchant_id,expected_environment)
 VALUES(cap,salon,organizer,gen_random_uuid(),'square','save_card',repeat('a',64),repeat('b',64),'{}','succeeded',gen_random_uuid(),'qa-group-card',repeat('d',64),jsonb_build_object('customer_id','qa-group-customer','card_brand','VISA','card_last4','1111'),now(),now(),now(),meta,'qa-group-customer','qa-merchant','sandbox');
 PERFORM pg_temp.assert_true((SELECT public.booking_card_protection_state(b)='saved' FROM public.bookings b WHERE id=organizer),'organizer has durable synthetic card receipt');
 result:=public.preview_booking_group_cancellation_for_desk(salon,grp,actor);
 PERFORM pg_temp.assert_true(result->>'decision_required'='true' AND result->>'fee_cents'='5000' AND result->>'group_size'='2','fee eligible before cancellation: two active members, CAD50');
 result:=public.mint_booking_management_capability(salon,organizer,'group_cancel',now()+interval '1 hour');
 PERFORM pg_temp.assert_true(result->>'ok'='true' AND result->>'scope_kind'='organizer_whole_party','whole-party capability minted');
 INSERT INTO group_fee_probe(cap) VALUES((result->>'token_id')::uuid);
END $seed$;


CREATE FUNCTION pg_temp.preview_fee() RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.preview_booking_group_cancellation_for_desk('fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000099','fc260926-0000-4000-8000-000000000004');
$$;
CREATE FUNCTION pg_temp.claim_fee(review uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.claim_approved_cancellation_fee_payment('group',review,'fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000004','owner');
$$;
SAVEPOINT seeded;
UPDATE public.salons SET noshow_fee_percent=5 WHERE id='fc260926-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'rate reduction cannot create inflated fee review');
DO $blocked_cancel$
DECLARE result jsonb; replay jsonb;
BEGIN
 result:=public.cancel_booking_group_for_desk_with_decision_truth('fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000099','fc260926-0000-4000-8000-000000000055','fc260926-0000-4000-8000-000000000004','not_applicable',false,false,20);
 PERFORM pg_temp.assert_true(result->>'success'='true' AND result->>'fee_reason'='group_fee_amount_exceeds_cap' AND result->>'fee_cents'='0','blocked fee preserves cancellation and truthful reason');
 replay:=public.cancel_booking_group_for_desk_with_decision_truth('fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000099','fc260926-0000-4000-8000-000000000055','fc260926-0000-4000-8000-000000000004','not_applicable',false,false,20);
 PERFORM pg_temp.assert_true(replay->>'idempotent'='true' AND replay->>'fee_reason'=result->>'fee_reason','cancellation replay retains exact safety reason');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 AND bool_and(amount_cents=0 AND state='not_applicable') FROM public.booking_group_cancellation_fee_reviews WHERE salon_id='fc260926-0000-4000-8000-000000000001'),'blocked cancellation records one zero-fee review');
END $blocked_cancel$;
ROLLBACK TO seeded;
UPDATE public.bookings SET price_cents=1000 WHERE group_id='fc260926-0000-4000-8000-000000000099';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'candidate cannot exceed displayed percent of liable booked value');
ROLLBACK TO seeded;
UPDATE public.bookings SET noshow_consent_meta=noshow_consent_meta - 'feeCents' WHERE id='fc260926-0000-4000-8000-000000000010';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'missing consent amount denied');
ROLLBACK TO seeded;
UPDATE public.bookings SET noshow_consent_meta=jsonb_set(noshow_consent_meta,'{feeCents}','"5000"') WHERE id='fc260926-0000-4000-8000-000000000010';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'string amount denied');
ROLLBACK TO seeded;
UPDATE public.bookings SET noshow_consent_meta=jsonb_set(noshow_consent_meta,'{feeCents}','-1') WHERE id='fc260926-0000-4000-8000-000000000010';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'negative amount denied');
ROLLBACK TO seeded;
UPDATE public.bookings SET noshow_consent_meta=jsonb_set(noshow_consent_meta,'{feeCents}','1.5') WHERE id='fc260926-0000-4000-8000-000000000010';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'fractional amount denied');
ROLLBACK TO seeded;
UPDATE public.bookings SET noshow_consent_meta=jsonb_set(noshow_consent_meta,'{feeCents}','2147483648') WHERE id='fc260926-0000-4000-8000-000000000010';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'overflow amount denied');
ROLLBACK TO seeded;
UPDATE public.bookings SET noshow_consent_meta=jsonb_set(noshow_consent_meta,'{currency}','"USD"') WHERE id='fc260926-0000-4000-8000-000000000010';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'currency mismatch denied');
ROLLBACK TO seeded;
UPDATE public.bookings SET noshow_consent_meta=jsonb_set(noshow_consent_meta,'{scope}','"unknown"') WHERE id='fc260926-0000-4000-8000-000000000010';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'unknown scope denied');
ROLLBACK TO seeded;

-- Individual organizer consent must not imply responsibility for everybody.
UPDATE public.bookings SET noshow_fee_cents=2500, noshow_consent_meta=noshow_consent_meta||'{"feeCents":2500,"scope":"booking_member"}' WHERE id='fc260926-0000-4000-8000-000000000010';
UPDATE public.booking_card_save_operations SET consent_meta=consent_meta||'{"feeCents":2500,"scope":"booking_member"}' WHERE booking_id='fc260926-0000-4000-8000-000000000010';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'fee_cents'='2500', 'organizer-only consent permits only organizer fee');
UPDATE public.salons SET noshow_fee_percent=10 WHERE id='fc260926-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(pg_temp.preview_fee()->>'decision_required'='false', 'organizer-only consent cannot become whole-group fee');
ROLLBACK TO seeded;
UPDATE public.salons SET feature_flags='{"approved_cancellation_fee_dispatch":true}' WHERE id='fc260926-0000-4000-8000-000000000001';
DO $cancel$
DECLARE result jsonb; review uuid;
BEGIN
 result:=public.cancel_booking_group_for_desk_with_decision_truth('fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000099','fc260926-0000-4000-8000-000000000051','fc260926-0000-4000-8000-000000000004','review',false,false,20);
 PERFORM pg_temp.assert_true(result->>'success'='true' AND result->>'fee_cents'='5000','valid desk cancellation snapshots CAD50');
 review:=(result->>'fee_review_id')::uuid;
 UPDATE group_fee_probe SET cancel_result=jsonb_build_object('review_id',review);
END $cancel$;
SAVEPOINT before_approval;
-- Historical inflated review still has a real immutable Owner approval receipt.
UPDATE public.booking_group_cancellation_fee_reviews SET amount_cents=20000 WHERE salon_id='fc260926-0000-4000-8000-000000000001';
DO $old_approval$
DECLARE review uuid; result jsonb;
BEGIN
 SELECT (cancel_result->>'review_id')::uuid INTO review FROM group_fee_probe;
 result:=public.decide_group_cancellation_fee_review(review,'fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000004','owner','fc260926-0000-4000-8000-000000000052','charge');
 PERFORM pg_temp.assert_true(result->>'success'='true','synthetic inflated review has genuine Owner approval');
 PERFORM pg_temp.assert_true(pg_temp.claim_fee(review)->>'success'='false','inflated Owner approval cannot bypass customer consent cap');
 PERFORM pg_temp.assert_true((SELECT count(*)=0 FROM public.booking_payment_operations WHERE salon_id='fc260926-0000-4000-8000-000000000001'),'inflated approval never creates provider operation');
END $old_approval$;
ROLLBACK TO before_approval;
DO $approve$
DECLARE review uuid; result jsonb;
BEGIN
 SELECT (cancel_result->>'review_id')::uuid INTO review FROM group_fee_probe;
 result:=public.decide_group_cancellation_fee_review(review,'fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000004','owner','fc260926-0000-4000-8000-000000000052','charge');
 PERFORM pg_temp.assert_true(result->>'success'='true','valid fee owner approval');
END $approve$;
SAVEPOINT approved;

UPDATE public.booking_group_cancellation_fee_reviews SET policy_snapshot=policy_snapshot-'fee_guard' WHERE salon_id='fc260926-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(pg_temp.claim_fee((cancel_result->>'review_id')::uuid)->>'code'='group_fee_snapshot_invalid','legacy review without guard cannot create a charge') FROM group_fee_probe;
ROLLBACK TO approved;
UPDATE public.square_integrations SET merchant_id='different-qa-merchant' WHERE salon_id='fc260926-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(pg_temp.claim_fee((cancel_result->>'review_id')::uuid)->>'success'='false','merchant change cannot redirect approved card charge') FROM group_fee_probe;
ROLLBACK TO approved;
DO $valid$
DECLARE review uuid; result jsonb; replay jsonb;
BEGIN
 SELECT (cancel_result->>'review_id')::uuid INTO review FROM group_fee_probe;
 result:=pg_temp.claim_fee(review);
 PERFORM pg_temp.assert_true(result->>'code'='claimed' AND result->'material'->>'amount_cents'='5000','valid CAD50 claim');
 PERFORM pg_temp.assert_true(result->'material'->>'provider_request_reference'='fc260926-0000-4000-8000-000000000010','existing Square reference preserved');
 replay:=pg_temp.claim_fee(review);
 PERFORM pg_temp.assert_true(replay->>'code'='in_flight' AND replay->>'operation_id'=result->>'operation_id','duplicate claim cannot dispatch twice');
 UPDATE public.booking_payment_operations SET status='unknown',error_code='provider_response_lost' WHERE id=(result->>'operation_id')::uuid;
 UPDATE public.salons SET noshow_fee_percent=5 WHERE id='fc260926-0000-4000-8000-000000000001';
 replay:=pg_temp.claim_fee(review);
 PERFORM pg_temp.assert_true(replay->>'code'='reconciliation_required' AND replay->>'operation_id'=result->>'operation_id','unknown operation stays reconciliation-only after policy drift');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 AND bool_and(amount_cents=5000 AND provider_payment_id IS NULL) FROM public.booking_payment_operations WHERE salon_id='fc260926-0000-4000-8000-000000000001'),'one operation, original amount, no provider receipt');
END $valid$;
ROLLBACK TO approved;
DO $completion$
DECLARE review uuid; claim jsonb; done jsonb; replay jsonb;
BEGIN
 SELECT (cancel_result->>'review_id')::uuid INTO review FROM group_fee_probe;
 claim:=pg_temp.claim_fee(review);
 done:=public.complete_booking_payment_operation((claim->>'operation_id')::uuid,(claim->>'attempt_token')::uuid,'succeeded','COMPLETED','qa-synthetic-group-payment',NULL,NULL);
 PERFORM pg_temp.assert_true(done->>'success'='true','synthetic success completes through actual SQL lifecycle');
 PERFORM pg_temp.assert_true((SELECT status='succeeded' AND amount_cents=5000 FROM public.booking_payment_operations WHERE id=(claim->>'operation_id')::uuid),'success receipt persists original CAD50');
 PERFORM pg_temp.assert_true((SELECT payment_status='succeeded' FROM public.booking_group_cancellation_fee_reviews WHERE id=review),'review projects successful synthetic receipt');
 replay:=pg_temp.claim_fee(review);
 PERFORM pg_temp.assert_true(replay->>'code'='operation_replay' AND replay->>'operation_id'=claim->>'operation_id' AND replay#>>'{result,provider_payment_id}'='qa-synthetic-group-payment','completed fee returns exact successful receipt');
 UPDATE public.bookings SET noshow_card_id=NULL,noshow_consent_at=NULL,customer_transition_version=customer_transition_version+1 WHERE id='fc260926-0000-4000-8000-000000000010';
 replay:=pg_temp.claim_fee(review);
 PERFORM pg_temp.assert_true(replay->>'code'='operation_replay' AND replay#>>'{result,provider_payment_id}'='qa-synthetic-group-payment','successful replay survives subsequent card removal and version change');
 PERFORM pg_temp.assert_true((SELECT attempt_count=1 FROM public.booking_payment_operations WHERE id=(claim->>'operation_id')::uuid),'successful replay does not increment provider attempts');
 PERFORM pg_temp.assert_true(public.claim_approved_cancellation_fee_payment('group',review,'fc260926-0000-4000-8000-000000000008','fc260926-0000-4000-8000-000000000004','owner')->>'success'='false','successful receipt is inaccessible cross tenant');
 PERFORM pg_temp.assert_true(public.claim_approved_cancellation_fee_payment('group',review,'fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000008','owner')->>'success'='false','successful receipt is inaccessible to non member');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 FROM public.booking_payment_operations WHERE salon_id='fc260926-0000-4000-8000-000000000001'),'successful lifecycle has one operation only');
 UPDATE public.booking_payment_operations SET material_json=jsonb_set(material_json,'{cancel_preview,review_id}',to_jsonb(gen_random_uuid()::text)) WHERE id=(claim->>'operation_id')::uuid;
 replay:=pg_temp.claim_fee(review);
 PERFORM pg_temp.assert_true(replay->>'code'='operation_conflict','successful receipt cannot be replayed against a mismatched review binding');

END $completion$;
ROLLBACK TO approved;
UPDATE public.bookings SET noshow_consent_meta=jsonb_set(noshow_consent_meta,'{policyVersion}',to_jsonb('nsp_'||repeat('b',64))) WHERE id='fc260926-0000-4000-8000-000000000010';
SELECT pg_temp.assert_true(pg_temp.claim_fee((cancel_result->>'review_id')::uuid)->>'success'='false','changed consent cannot claim approved old fee') FROM group_fee_probe;
ROLLBACK TO approved;
SELECT pg_temp.assert_true(public.claim_approved_cancellation_fee_payment('group',(cancel_result->>'review_id')::uuid,'fc260926-0000-4000-8000-000000000008','fc260926-0000-4000-8000-000000000004','owner')->>'success'='false','cross tenant claim denied') FROM group_fee_probe;
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.booking_payment_operations WHERE salon_id='fc260926-0000-4000-8000-000000000001'),'denied claims created zero operations');
SELECT pg_temp.assert_true(NOT has_function_privilege('anon','public.claim_approved_cancellation_fee_payment(text,uuid,uuid,uuid,text)','execute') AND NOT has_function_privilege('authenticated','public.preview_booking_group_cancellation_for_desk(uuid,uuid,uuid)','execute'),'browser cannot execute privileged fee functions');
ROLLBACK TO seeded;
UPDATE public.salons SET feature_flags='{"approved_cancellation_fee_dispatch":true}' WHERE id='fc260926-0000-4000-8000-000000000001';
DO $late_replay$
DECLARE review uuid:=gen_random_uuid(); approval uuid:=gen_random_uuid(); claim jsonb; done jsonb; replay jsonb;
BEGIN
 UPDATE public.bookings SET group_id=NULL,is_party_member=false,is_group_organizer=false WHERE id='fc260926-0000-4000-8000-000000000010';
 UPDATE public.bookings SET status='cancelled',customer_transition_version=1 WHERE id='fc260926-0000-4000-8000-000000000010';
 SELECT id INTO review FROM public.booking_late_cancellation_fee_reviews WHERE booking_id='fc260926-0000-4000-8000-000000000010' AND cancellation_occurrence_version=1;
 done:=public.decide_late_cancellation_fee_review(review,'fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000004','owner',approval,'charge');
 PERFORM pg_temp.assert_true(done->>'success'='true','late fee approval succeeds');
 claim:=public.claim_approved_cancellation_fee_payment('late',review,'fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000004','owner');
 PERFORM pg_temp.assert_true(claim->>'code'='claimed','late fee claimed once: '||coalesce(claim->>'code','null'));
 done:=public.complete_booking_payment_operation((claim->>'operation_id')::uuid,(claim->>'attempt_token')::uuid,'succeeded','COMPLETED','qa-synthetic-late-payment',NULL,NULL);
 PERFORM pg_temp.assert_true(done->>'success'='true','late fee completed');
 UPDATE public.bookings SET noshow_card_id=NULL,noshow_consent_at=NULL,customer_transition_version=customer_transition_version+1 WHERE id='fc260926-0000-4000-8000-000000000010';
 replay:=public.claim_approved_cancellation_fee_payment('late',review,'fc260926-0000-4000-8000-000000000001','fc260926-0000-4000-8000-000000000004','owner');
 PERFORM pg_temp.assert_true(replay->>'code'='operation_replay' AND replay->>'operation_id'=claim->>'operation_id' AND replay#>>'{result,provider_payment_id}'='qa-synthetic-late-payment','late successful replay returns exact receipt after mutable state changes');
 PERFORM pg_temp.assert_true((SELECT count(*)=1 AND bool_and(attempt_count=1) FROM public.booking_payment_operations WHERE salon_id='fc260926-0000-4000-8000-000000000001'),'late replay neither creates nor redispatches payment');
END $late_replay$;
ROLLBACK;
