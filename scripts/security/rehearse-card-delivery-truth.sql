\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
CREATE FUNCTION pg_temp.check_card_truth(p_ok boolean,p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',p_label; END IF; END; $$;
INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('card-truth-qa','Card QA','Card QA') ON CONFLICT DO NOTHING;
INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete,opening_hours,noshow_protection_enabled,
 cancellation_policy,self_cancel_fee_enabled,self_cancel_window_hours,self_cancel_fee_percent,noshow_fee_percent)
VALUES('55630000-0000-4000-8000-000000000001','card-truth-qa','Synthetic Card QA','+16045550100','America/Vancouver','CAD',true,
 '{"mon":{"open":"00:00","close":"23:59"},"tue":{"open":"00:00","close":"23:59"},"wed":{"open":"00:00","close":"23:59"},"thu":{"open":"00:00","close":"23:59"},"fri":{"open":"00:00","close":"23:59"},"sat":{"open":"00:00","close":"23:59"},"sun":{"open":"00:00","close":"23:59"}}',true,
 '{"en":"Cancel with 24 hours notice.","vi":"Báo trước 24 giờ khi hủy."}',true,24,20,20);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('55630000-0000-4000-8000-000000000002','55630000-0000-4000-8000-000000000001','Synthetic Service',5000,30,'card-truth-qa');
INSERT INTO public.staff(id,salon_id,name,status) VALUES('55630000-0000-4000-8000-000000000003','55630000-0000-4000-8000-000000000001','QA Staff','active');

DO $$
DECLARE salon uuid:='55630000-0000-4000-8000-000000000001'; booking uuid; cap uuid; retry_cap uuid;
 op jsonb; result jsonb; second_result jsonb; consent jsonb:=jsonb_build_object('v',2,'policyVersion','nsp_'||repeat('a',64),
 'feeCents',1000,'currency','CAD','scope','booking_member','policyEn','Cancel with 24 hours notice.','policyVi','Báo trước 24 giờ.');
 clock_at timestamptz:=transaction_timestamp(); lease uuid; i integer; before_count integer;
 row_booking public.bookings%ROWTYPE; row_salon public.salons%ROWTYPE;
BEGIN
 SELECT * INTO row_salon FROM public.salons WHERE id=salon;
 FOR i IN 1..16 LOOP
   booking:=('55630000-0000-4000-8000-'||lpad((100+i)::text,12,'0'))::uuid;
   INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_email,start_time_utc,end_time_utc,status,
      price_cents,noshow_card_required,noshow_fee_cents)
   VALUES(booking,salon,'55630000-0000-4000-8000-000000000002','55630000-0000-4000-8000-000000000003',
      'Synthetic Guest','synthetic@example.test',date_trunc('hour',clock_at)+make_interval(days=>3,hours=>i),
      date_trunc('hour',clock_at)+make_interval(days=>3,hours=>i,mins=>30),'confirmed',5000,true,1000);
   SELECT * INTO row_booking FROM public.bookings WHERE id=booking;
   PERFORM pg_temp.check_card_truth(row_booking.card_protection_status='awaiting_card','required is not saved');
   result:=public.booking_late_cancellation_snapshot(row_booking,row_salon,clock_at);
   PERFORM pg_temp.check_card_truth(result->>'has_chargeable_card'='false','missing receipt cannot be charged');
   cap:=(public.mint_booking_management_capability(salon,booking,'card_manage',clock_at+interval '25 minutes')->>'token_id')::uuid;
   op:=public.claim_booking_card_save_operation(cap,extensions.gen_random_uuid(),'square','save_card',repeat('b',64));
   PERFORM pg_temp.check_card_truth(op->>'code'='claimed','claim');
   -- Invalid/missing lease must be rejected even though old SQL NULL comparisons accepted it.
   result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,extensions.gen_random_uuid(),'not_found');
   PERFORM pg_temp.check_card_truth(result->>'code'='claim_mismatch','null lease fence');
   IF i IN (1,13,14) THEN
     PERFORM public.record_booking_card_delivery_failure((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
       'configuration','square_config_unavailable',NULL,'{}','{}','safe_retry');
     result:=public.complete_booking_card_save_operation((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
       'failed',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'square_config_unavailable');
     PERFORM pg_temp.check_card_truth(result->>'code'='save_failed','config closure');
     IF i IN (13,14) THEN
       IF i=14 THEN
         BEGIN
           PERFORM public.record_booking_existing_square_card(booking,salon,'customer_qa','card_existing','merchant_qa','sandbox','UNKNOWN','4242',
             consent||'{"source":"explicit_reuse","receiptSource":"existing_card_read"}'::jsonb);
           RAISE EXCEPTION 'FAIL: invalid reuse receipt accepted';
         EXCEPTION WHEN raise_exception THEN
           IF SQLERRM<>'existing_card_receipt_unavailable' THEN RAISE; END IF;
         END;
         PERFORM pg_temp.check_card_truth((SELECT count(*)=1 FROM public.booking_card_save_operations WHERE booking_id=booking),'invalid reuse transaction rolls back');
       ELSE
         result:=public.record_booking_existing_square_card(booking,salon,'customer_qa','card_existing','merchant_qa','sandbox','VISA','4242',
           consent||'{"source":"explicit_reuse","receiptSource":"existing_card_read"}'::jsonb);
         PERFORM pg_temp.check_card_truth(result->>'ok'='true','existing read receipt atomically stored');
         PERFORM pg_temp.check_card_truth((SELECT max(delivery_sequence) FILTER (WHERE status='succeeded')>
           max(delivery_sequence) FILTER (WHERE status='failed') AND count(DISTINCT created_at)=1
           FROM public.booking_card_save_operations WHERE booking_id=booking),
           'new receipt is ordered after failed attempt within the same transaction');
         result:=public.record_booking_existing_square_card(booking,salon,'customer_qa','card_existing','merchant_qa','sandbox','VISA','4242',
           consent||'{"source":"explicit_reuse","receiptSource":"existing_card_read"}'::jsonb);
         PERFORM pg_temp.check_card_truth(result->>'idempotent'='true','existing card replay returns durable receipt');
         PERFORM pg_temp.check_card_truth((SELECT card_protection_status='saved' FROM public.bookings WHERE id=booking),'existing card protected only after atomic receipt');
       END IF;
       CONTINUE;
     END IF;
   ELSE
     result:=public.prepare_booking_card_save_dispatch((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,clock_at,consent);
     PERFORM pg_temp.check_card_truth(result->>'ok'='true','consent preparation');
     result:=public.bind_booking_card_save_dispatch((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,'customer_qa','merchant_qa','sandbox');
     PERFORM pg_temp.check_card_truth(result->>'ok'='true','customer binding');
     IF i=2 THEN
       PERFORM public.record_booking_card_delivery_failure((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
         'card_create','square_card_create_failed',400,ARRAY['CARD_DECLINED'],ARRAY['PAYMENT_METHOD_ERROR'],'new_card');
       result:=public.complete_booking_card_save_operation((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
         'failed',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'square_card_create_failed');
       second_result:=public.complete_booking_card_save_operation((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
         'failed',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'square_card_create_failed');
       PERFORM pg_temp.check_card_truth(second_result->>'idempotent'='true','decline idempotency');
     ELSIF i IN (3,15) THEN
       result:=public.complete_booking_card_save_operation((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
         'succeeded','card_qa','card_qa','customer_wrong','VISA','4242',clock_at,consent,NULL);
       PERFORM pg_temp.check_card_truth(result->>'code'='invalid_completion','customer binding mismatch');
       result:=public.complete_booking_card_save_operation((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
         'succeeded','card_qa','card_qa','customer_qa','VISA','',clock_at,consent,NULL);
       PERFORM pg_temp.check_card_truth(result->>'code'='invalid_completion','missing last4');
       result:=public.complete_booking_card_save_operation((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
         'succeeded','card_qa','card_qa','customer_qa','VISA','4242',clock_at,consent,NULL);
       PERFORM pg_temp.check_card_truth(result->>'ok'='true','successful completion');
       SELECT * INTO row_booking FROM public.bookings WHERE id=booking;
       PERFORM pg_temp.check_card_truth(row_booking.card_protection_status='saved','saved projection atomically refreshed');
       PERFORM pg_temp.check_card_truth(row_booking.noshow_customer_id='customer_qa' AND row_booking.noshow_consent_meta=consent,'binding and consent attached');
       IF i=15 THEN
         -- Missing IDs alone must not unlock entry; the actual successful
         -- removal RPC provides the durable receipt that safely closes it.
         UPDATE public.bookings SET noshow_card_id=NULL,noshow_customer_id=NULL,noshow_charge_status='removed_by_customer' WHERE id=booking;
         PERFORM pg_temp.check_card_truth((SELECT card_protection_status='manual_review' FROM public.bookings WHERE id=booking),'unproven removal remains manual');
         UPDATE public.bookings SET noshow_card_id='card_qa',noshow_customer_id='customer_qa',noshow_charge_status='saved' WHERE id=booking;
         retry_cap:=(public.mint_booking_management_capability(salon,booking,'card_manage',clock_at+interval '26 minutes')->>'token_id')::uuid;
         second_result:=public.claim_booking_card_management_operation(retry_cap,extensions.gen_random_uuid(),
           encode(extensions.digest(convert_to(jsonb_build_object('card_id','card_qa','customer_id','customer_qa','charge_status','saved')::text,'UTF8'),'sha256'),'hex'));
         PERFORM pg_temp.check_card_truth(second_result->>'code'='claimed','replacement removal claim');
         result:=public.complete_booking_card_management_operation((second_result->>'operation_id')::uuid,
           (second_result->>'attempt_token')::uuid,'succeeded','card_qa',NULL);
         PERFORM pg_temp.check_card_truth(result->>'code'='removed','replacement removal receipt');
         result:=public.inspect_booking_card_recovery(retry_cap);
         PERFORM pg_temp.check_card_truth(result->>'protection_status'='retry_required' AND result->>'can_retry'='true','proven removal enables replacement');
         result:=public.recover_booking_card_management(retry_cap);
         PERFORM pg_temp.check_card_truth(result->>'ok'='true','replacement capability mint');
         CONTINUE;
       END IF;
       -- Attempting to forge the projection cannot override missing receipt material.
       UPDATE public.bookings SET noshow_card_last4=NULL,card_protection_status='saved' WHERE id=booking;
       SELECT * INTO row_booking FROM public.bookings WHERE id=booking;
       PERFORM pg_temp.check_card_truth(row_booking.card_protection_status='manual_review','receipt loss overrides forged saved state');
       result:=public.claim_booking_card_save_operation(cap,(SELECT request_id FROM public.booking_card_save_operations
         WHERE id=(op->>'operation_id')::uuid),'square','save_card',repeat('b',64));
       PERFORM pg_temp.check_card_truth(result->>'code'='card_state_changed','cached success cannot certify a damaged receipt');
       CONTINUE;
     ELSE
       IF i<>9 THEN
         PERFORM public.record_booking_card_delivery_failure((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
           'card_create','provider_response_lost',NULL,'{}','{}','reconcile_first');
         result:=public.complete_booking_card_save_operation((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,
           'unknown',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'provider_response_lost');
       END IF;
       -- A different capability must not bypass the booking-wide unresolved operation.
       retry_cap:=(public.mint_booking_management_capability(salon,booking,'card_manage',clock_at+interval '26 minutes')->>'token_id')::uuid;
       result:=public.claim_booking_card_save_operation(retry_cap,extensions.gen_random_uuid(),'square','save_card',repeat('c',64));
       PERFORM pg_temp.check_card_truth(result->>'code'='reconciliation_required','fresh token cannot redispatch unknown');
       lease:=extensions.gen_random_uuid();
       UPDATE public.booking_card_save_operations SET reconciliation_token=lease,reconciliation_lease_expires_at=clock_at+interval '2 minutes'
         WHERE id=(op->>'operation_id')::uuid;
       IF i IN (4,9) THEN
         IF i=9 THEN
           UPDATE public.booking_management_capabilities SET revoked_at=clock_at,revoke_reason='manual_revoke' WHERE id=cap;
         END IF;
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'found','card_found','customer_qa','VISA','4242');
         PERFORM pg_temp.check_card_truth(result->>'code'='reconciled_saved','response or DB loss recovered');
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'found','card_found','customer_qa','VISA','4242');
         PERFORM pg_temp.check_card_truth(result->>'idempotent'='true','reconcile success replay');
         SELECT * INTO row_booking FROM public.bookings WHERE id=booking;
         PERFORM pg_temp.check_card_truth(row_booking.card_protection_status='saved','reconciled protection active');
         IF i=9 THEN
           result:=public.inspect_booking_card_recovery(cap);
           PERFORM pg_temp.check_card_truth(result->>'code'='expired_or_revoked','reconciliation cannot revive explicitly revoked authority');
           PERFORM pg_temp.check_card_truth((SELECT revoke_reason='manual_revoke' FROM public.booking_management_capabilities WHERE id=cap),'original revocation reason preserved');
         END IF;
         CONTINUE;
       ELSIF i=5 THEN
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'multiple_matches');
         PERFORM pg_temp.check_card_truth(result->>'code'='manual_review_required','multiple matches manual');
         PERFORM pg_temp.check_card_truth((SELECT card_protection_status='manual_review' FROM public.bookings WHERE id=booking),'manual cannot look protected');
         PERFORM pg_temp.check_card_truth((SELECT error_code='provider_response_lost' FROM public.booking_card_save_operations WHERE id=(op->>'operation_id')::uuid),'original cause retained');
         CONTINUE;
       ELSIF i=6 THEN
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'invalid_card');
         PERFORM pg_temp.check_card_truth(result->>'code'='manual_review_required','invalid receipt manual'); CONTINUE;
       ELSIF i=7 THEN
         SELECT reconciliation_attempt_count INTO before_count FROM public.booking_card_save_operations WHERE id=(op->>'operation_id')::uuid;
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'read_failed');
         PERFORM pg_temp.check_card_truth((SELECT reconciliation_attempt_count=before_count FROM public.booking_card_save_operations WHERE id=(op->>'operation_id')::uuid),'network read not counted');
         PERFORM pg_temp.check_card_truth(result->>'code'='reconciliation_pending','network is not not-found'); CONTINUE;
       ELSIF i IN (10,11) THEN
         UPDATE public.booking_card_save_operations SET consent_meta='{"v":1,"fee_cents":1000}'::jsonb WHERE id=(op->>'operation_id')::uuid;
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'found','card_legacy','customer_qa','VISA','4242');
         PERFORM pg_temp.check_card_truth(result->>'code'='manual_review_required','legacy consent never silently upgraded');
         result:=public.inspect_booking_card_recovery(retry_cap);
         PERFORM pg_temp.check_card_truth(result->>'can_refresh_consent'='true' AND result->>'protection_status'='manual_review','one valid read offers fresh consent');
         IF i=10 THEN
           result:=public.refresh_booking_card_recovery_consent(retry_cap,(op->>'operation_id')::uuid,consent);
           PERFORM pg_temp.check_card_truth(result->>'code'='reconciled_saved','fresh consent activates recovered receipt');
           result:=public.refresh_booking_card_recovery_consent(retry_cap,(op->>'operation_id')::uuid,consent);
           PERFORM pg_temp.check_card_truth(result->>'idempotent'='true','fresh consent response replay is idempotent');
           PERFORM pg_temp.check_card_truth((SELECT consent_meta='{"v":1,"fee_cents":1000}'::jsonb FROM public.booking_card_save_operations WHERE id=(op->>'operation_id')::uuid),'original consent retained');
         ELSE
           UPDATE public.booking_card_save_operations SET reconciliation_token=lease,reconciliation_lease_expires_at=clock_at+interval '2 minutes' WHERE id=(op->>'operation_id')::uuid;
           PERFORM public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'multiple_matches');
           result:=public.refresh_booking_card_recovery_consent(retry_cap,(op->>'operation_id')::uuid,consent);
           PERFORM pg_temp.check_card_truth(result->>'ok'='false','later ambiguity invalidates consent candidate');
         END IF;
         CONTINUE;
       ELSIF i=16 THEN
         UPDATE public.booking_card_save_operations SET expected_customer_id=NULL WHERE id=(op->>'operation_id')::uuid;
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'disabled_card','card_disabled','customer_qa','VISA','4242');
         PERFORM pg_temp.check_card_truth(result->>'code'='manual_review_required','unbound disabled card cannot unlock entry');
         UPDATE public.booking_card_save_operations SET expected_customer_id='customer_qa',delivery_version=NULL,
           reconciliation_token=lease,reconciliation_lease_expires_at=clock_at+interval '2 minutes' WHERE id=(op->>'operation_id')::uuid;
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'disabled_card','card_disabled','customer_qa','VISA','4242');
         PERFORM pg_temp.check_card_truth(result->>'code'='manual_review_required','legacy disabled identity is not guessed');
         UPDATE public.booking_card_save_operations SET delivery_version=2,
           reconciliation_token=lease,reconciliation_lease_expires_at=clock_at+interval '2 minutes' WHERE id=(op->>'operation_id')::uuid;
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'disabled_card','card_disabled','customer_qa','VISA','4242');
         PERFORM pg_temp.check_card_truth(result->>'code'='retry_required','fully bound disabled receipt closes prior operation');
         PERFORM pg_temp.check_card_truth((SELECT status='failed' AND reconciliation_receipt->>'enabled'='false'
           AND resolution_code='customer_reentry_required' FROM public.booking_card_save_operations WHERE id=(op->>'operation_id')::uuid),'disabled receipt retained with safe closure');
         PERFORM pg_temp.check_card_truth(EXISTS(SELECT 1 FROM public.booking_card_delivery_events WHERE operation_id=(op->>'operation_id')::uuid
           AND reconciliation_outcome='disabled_card' AND retryability='safe_retry'),'disabled outcome history retained');
         cap:=retry_cap;
       ELSIF i=12 THEN
         UPDATE public.booking_card_save_operations SET reconciliation_lease_expires_at=clock_at-interval '1 second' WHERE id=(op->>'operation_id')::uuid;
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'found','card_qa','customer_qa','VISA','4242');
         PERFORM pg_temp.check_card_truth(result->>'code'='claim_mismatch','expired lease cannot complete');
         PERFORM pg_temp.check_card_truth((SELECT noshow_card_id IS NULL FROM public.bookings WHERE id=booking),'stale worker does not write booking');
         CONTINUE;
       ELSE
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'not_found');
         PERFORM pg_temp.check_card_truth(result->>'code'='reconciliation_pending','zero match does not immediately release');
         -- Synthetic clock adjustment, never on a hosted DB. Three complete empty
         -- reads must still wait the full observation window before retry closure.
         UPDATE public.booking_card_save_operations SET created_at=clock_at-interval '21 minutes',
           consent_at=clock_at-interval '20 minutes',dispatch_prepared_at=clock_at-interval '20 minutes',
           reconciliation_empty_count=2,reconciliation_token=lease,reconciliation_lease_expires_at=clock_at+interval '2 minutes'
           WHERE id=(op->>'operation_id')::uuid;
         result:=public.complete_booking_card_save_reconciliation((op->>'operation_id')::uuid,lease,'not_found');
         PERFORM pg_temp.check_card_truth(result->>'code'='retry_required','safe exhaustion permits new entry');
         cap:=retry_cap;
       END IF;
     END IF;
   END IF;
   result:=public.inspect_booking_card_recovery(cap);
   PERFORM pg_temp.check_card_truth(result->>'protection_status'='retry_required' AND result->>'can_retry'='true','reload keeps failed reservation recoverable');
   result:=public.recover_booking_card_management(cap);
   second_result:=public.recover_booking_card_management(cap);
   PERFORM pg_temp.check_card_truth(result->>'ok'='true' AND result->>'token_id'=second_result->>'token_id','retry link idempotent');
   SELECT * INTO row_booking FROM public.bookings WHERE id=booking;
   PERFORM pg_temp.check_card_truth(row_booking.status='confirmed' AND row_booking.noshow_card_id IS NULL,'reservation preserved without card');
 END LOOP;
 PERFORM pg_temp.check_card_truth(NOT has_table_privilege('anon','public.booking_card_delivery_events','SELECT'),'anonymous diagnostics denied');
 PERFORM pg_temp.check_card_truth(NOT has_table_privilege('authenticated','public.booking_card_delivery_events','SELECT'),'tenant clients cannot read other salon diagnostics');
 PERFORM pg_temp.check_card_truth(NOT has_table_privilege('authenticated','public.square_card_customer_claims','SELECT'),'customer identity business material is service only');
 PERFORM pg_temp.check_card_truth(NOT has_function_privilege('authenticated','public.claim_square_card_customer(uuid,uuid)','EXECUTE'),'customer creation claim is service only');
 PERFORM pg_temp.check_card_truth(public.square_card_contact_fingerprint('{"client_phone":"6045550199"}',booking)
   =public.square_card_contact_fingerprint('{"client_phone":"+1 (604) 555-0199"}',extensions.gen_random_uuid()),'NANP variants share customer identity');
 PERFORM pg_temp.check_card_truth(public.square_card_contact_fingerprint('{"client_email":" QA@EXAMPLE.TEST "}',booking)
   =public.square_card_contact_fingerprint('{"client_email":"qa@example.test"}',extensions.gen_random_uuid()),'normalized email fallback shares customer identity');
 PERFORM pg_temp.check_card_truth(public.square_card_contact_fingerprint('{"client_name":"Synthetic Same"}',booking)
   <>public.square_card_contact_fingerprint('{"client_name":"Synthetic Same"}',extensions.gen_random_uuid()),'missing contact is isolated by booking, never by name');
 result:=public.claim_square_card_customer((op->>'operation_id')::uuid,extensions.gen_random_uuid());
 PERFORM pg_temp.check_card_truth(result->>'code'='claim_mismatch','arbitrary attempt cannot claim a customer identity');
 PERFORM pg_temp.check_card_truth(NOT has_function_privilege('authenticated','public.inspect_booking_card_recovery(uuid)','EXECUTE'),'recovery RPC service only');
 PERFORM pg_temp.check_card_truth(NOT has_function_privilege('authenticated','public.mint_owner_booking_card_retry(uuid,uuid,uuid)','EXECUTE'),'owner link RPC service only');
 result:=public.mint_owner_booking_card_retry(booking,salon,extensions.gen_random_uuid());
 PERFORM pg_temp.check_card_truth(result->>'code'='forbidden','owner link requires actual tenant membership');
 PERFORM pg_temp.check_card_truth(NOT has_function_privilege('service_role','public.complete_booking_card_save_operation_pre_delivery_truth(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text)','EXECUTE'),'cannot bypass hardened completion');
 BEGIN UPDATE public.booking_card_delivery_events SET code='fake'; RAISE EXCEPTION 'FAIL: mutable event history';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'card_delivery_history_is_immutable' THEN RAISE; END IF; END;
 RAISE NOTICE 'PASS: card delivery SQL scenarios, leases, receipt truth, recovery, grants and append-only history';
END; $$;
ROLLBACK;
