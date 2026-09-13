-- Offline disposable QA only: synthetic records, simulated provider receipts.
-- No provider transport exists in this SQL suite. Every write rolls back.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('request.jwt.claim.role','service_role',true);
CREATE TEMP TABLE qa_r10_results(scenario text PRIMARY KEY,passed boolean NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE qa_r10_context(salon uuid,service uuid,staff uuid) ON COMMIT DROP;
CREATE TEMP SEQUENCE qa_r10_slots;
DO $setup$
DECLARE s uuid:=extensions.gen_random_uuid(); sv uuid:=extensions.gen_random_uuid(); st uuid:=extensions.gen_random_uuid();
BEGIN
  INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('qa-r10-'||s,'Synthetic R10','Synthetic R10');
  INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete)
    VALUES(s,'disposable-r10-'||s,'Synthetic R10','','UTC','CAD',true);
  INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
    VALUES(sv,s,'Synthetic R10 Service',2000,30,'qa-r10-'||s);
  INSERT INTO public.staff(id,salon_id,name,status) VALUES(st,s,'Synthetic R10 Staff','active');
  INSERT INTO qa_r10_context VALUES(s,sv,st);
END;$setup$;
CREATE FUNCTION pg_temp.r10_operation(p_phone text,p_channel text DEFAULT 'none',p_booking uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE c record; b uuid:=p_booking; o uuid; cap jsonb; n integer:=nextval('pg_temp.qa_r10_slots');
  op uuid:=extensions.gen_random_uuid(); attempt uuid:=extensions.gen_random_uuid(); material jsonb;
BEGIN
  SELECT * INTO c FROM qa_r10_context;
  IF b IS NULL THEN
    INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,client_email,
      start_time_utc,end_time_utc,status,price_cents,noshow_card_required,noshow_fee_cents)
    VALUES(c.salon,c.service,c.staff,'Synthetic R10 Contact',p_phone,'synthetic-r10@example.test',
      now()+interval '8 days'+n*interval '1 hour',now()+interval '8 days 30 minutes'+n*interval '1 hour','confirmed',2000,true,500)
      RETURNING id INTO b;
    IF p_channel<>'none' THEN
      INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel,verified_at,expires_at)
        VALUES(p_phone,c.salon,CASE WHEN p_channel='sms_unconsumed' THEN 'sms' ELSE p_channel END,
          clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour') RETURNING id INTO o;
      UPDATE public.bookings SET otp_session_id=o WHERE id=b;
      IF p_channel<>'sms_unconsumed' THEN
        UPDATE public.phone_otp_sessions SET consumed_at=clock_timestamp(),consumed_by_booking_id=b WHERE id=o;
      END IF;
    END IF;
  END IF;
  -- Fixture setup models a separately issued recovery capability after the
  -- prior operation has terminated; mint intentionally reuses active tokens.
  IF p_booking IS NOT NULL THEN
    UPDATE public.booking_management_capabilities SET revoked_at=clock_timestamp(),revoke_reason='card_delivery_settled'
      WHERE booking_id=b AND action='card_manage' AND revoked_at IS NULL;
  END IF;
  cap:=public.mint_booking_management_capability(c.salon,b,'card_manage',now()+interval '25 minutes');
  IF cap->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'synthetic capability failed: %',cap; END IF;
  SELECT jsonb_build_object('client_name',client_name,'client_phone',client_phone,'client_email',client_email) INTO material
    FROM public.bookings WHERE id=b;
  INSERT INTO public.booking_card_save_operations(id,capability_id,salon_id,booking_id,request_id,provider,mode,
    source_fingerprint,initial_card_fingerprint,provider_material,status,attempt_token,
    dispatch_prepared_at,consent_at,consent_meta,expected_merchant_id,expected_environment,customer_delivery_version)
    VALUES(op,(cap->>'token_id')::uuid,c.salon,b,extensions.gen_random_uuid(),'square','save_card',repeat('a',64),repeat('b',64),
      material,'sending',attempt,clock_timestamp(),clock_timestamp(),jsonb_build_object('v',2,'policyVersion','nsp_'||repeat('a',64)),'merchant_r10','sandbox',1);
  RETURN jsonb_build_object('operation',op,'attempt',attempt,'booking',b,'salon',c.salon,'otp',o,'capability',cap->>'token_id');
END;$function$;
CREATE FUNCTION pg_temp.r10_claim(p_op jsonb) RETURNS jsonb LANGUAGE sql AS $function$
  SELECT public.claim_square_card_customer((p_op->>'operation')::uuid,(p_op->>'attempt')::uuid);
$function$;
CREATE FUNCTION pg_temp.r10_complete(p_op jsonb,p_claim jsonb,p_outcome text,p_customer text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $function$
  SELECT public.complete_square_card_customer((p_op->>'operation')::uuid,(p_op->>'attempt')::uuid,
    (p_claim->>'claim_id')::uuid,(p_claim->>'lease_token')::uuid,p_outcome,p_customer);
$function$;
CREATE FUNCTION pg_temp.r10_fail(p_op jsonb,p_claim uuid DEFAULT NULL) RETURNS void LANGUAGE sql AS $function$
  UPDATE public.booking_card_save_operations SET status='failed',completed_at=clock_timestamp(),result_json='{}',
    completion_fingerprint=repeat('c',64),error_code='square_customer_search_failed',customer_claim_id=coalesce(p_claim,customer_claim_id)
    WHERE id=(p_op->>'operation')::uuid;
$function$;
CREATE FUNCTION pg_temp.r10_legacy(p_op jsonb,p_known boolean) RETURNS uuid LANGUAGE plpgsql AS $function$
DECLARE x uuid:=extensions.gen_random_uuid();
BEGIN
  INSERT INTO public.square_card_customer_claims(id,salon_id,merchant_id,environment,contact_fingerprint,anchor_operation_id,
    request_material,reference_id,idempotency_key,status,customer_id,dispatch_prepared_at,empty_read_count)
    SELECT x,salon_id,expected_merchant_id,expected_environment,public.square_card_contact_fingerprint(provider_material,booking_id),id,
      provider_material,'nq-customer:'||x,'sqcu:'||x,CASE WHEN p_known THEN 'known' ELSE 'unknown' END,
      CASE WHEN p_known THEN 'legacy_customer_'||x END,clock_timestamp()-interval '20 minutes',CASE WHEN p_known THEN 0 ELSE 2 END
      FROM public.booking_card_save_operations WHERE id=(p_op->>'operation')::uuid;
  PERFORM pg_temp.r10_fail(p_op,x); RETURN x;
END;$function$;
DO $tests$
DECLARE a jsonb; b jsonb; c jsonb; d jsonb; r jsonb; channel text; i integer:=0;
  legacy uuid; legacy2 uuid; current_op jsonb; old_row jsonb; key_ref jsonb; scope_claim uuid; fake uuid:=extensions.gen_random_uuid();
BEGIN
  FOREACH channel IN ARRAY ARRAY['none','email','staff_attested','demo','sms_unconsumed'] LOOP
    i:=i+1; a:=pg_temp.r10_operation('17035550'||lpad(i::text,3,'0'),channel); c:=pg_temp.r10_claim(a);
    IF c->>'code' IS DISTINCT FROM 'claimed_v2' OR c->>'lookup_mode' IS DISTINCT FROM 'booking_reference'
      OR c->>'identity_version' IS DISTINCT FROM '2' OR c->>'operation_id' IS DISTINCT FROM a->>'operation'
      OR c->>'booking_id' IS DISTINCT FROM a->>'booking' OR c->'request_material'->>'client_phone' IS NOT NULL
      OR c->'request_material'->>'client_email' IS NOT NULL OR c->>'previously_dispatched' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'unproved authority exposed contact or old executable code: %',channel;
    END IF;
    INSERT INTO qa_r10_results VALUES('unproved '||channel||' uses sanitized booking identity',true);
  END LOOP;
  a:=pg_temp.r10_operation('17035550110','none'); b:=pg_temp.r10_operation('17035550110','none');
  c:=pg_temp.r10_claim(a); d:=pg_temp.r10_claim(b);
  IF c->>'claim_id'=d->>'claim_id' OR c->>'reference_id'=d->>'reference_id' THEN RAISE EXCEPTION 'unverified contacts merged'; END IF;
  INSERT INTO qa_r10_results VALUES('two unverified bookings do not share customer',true);

  a:=pg_temp.r10_operation('17035550111','sms'); b:=pg_temp.r10_operation('+17035550111','sms');
  c:=pg_temp.r10_claim(a); d:=pg_temp.r10_claim(b);
  IF c->>'lookup_mode' IS DISTINCT FROM 'verified_phone' OR c->'request_material'->>'client_phone'<>'17035550111'
    OR c->'request_material'->>'client_email' IS NOT NULL OR d->>'code'<>'customer_wait' THEN RAISE EXCEPTION 'verified shared lease failed'; END IF;
  r:=pg_temp.r10_complete(a,c,'found','customer_verified');
  IF r->>'code'<>'known' THEN RAISE EXCEPTION 'verified completion failed'; END IF;
  d:=pg_temp.r10_claim(b);
  IF d->>'code'<>'known' OR d->>'customer_id'<>'customer_verified' OR d->>'lookup_mode'<>'verified_phone'
    OR (SELECT customer_claim_id FROM public.booking_card_save_operations WHERE id=(a->>'operation')::uuid)
      IS DISTINCT FROM (SELECT customer_claim_id FROM public.booking_card_save_operations WHERE id=(b->>'operation')::uuid) THEN
    RAISE EXCEPTION 'verified cache failed'; END IF;
  r:=pg_temp.r10_complete(a,c,'found','customer_verified');
  IF r->>'idempotent' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'exact completion replay failed'; END IF;
  INSERT INTO qa_r10_results VALUES('verified canonical phone shares one lease and cached identity',true);

  a:=pg_temp.r10_operation('17035550112','sms');
  UPDATE public.phone_otp_sessions SET consumed_at=clock_timestamp()+interval '1 day',expires_at=clock_timestamp()+interval '2 days' WHERE id=(a->>'otp')::uuid;
  c:=pg_temp.r10_claim(a);
  IF c->>'lookup_mode'<>'booking_reference' THEN RAISE EXCEPTION 'future SMS accepted'; END IF;
  INSERT INTO qa_r10_results VALUES('future consumed SMS is not authority',true);
  a:=pg_temp.r10_operation('17035550113','sms');
  UPDATE public.phone_otp_sessions SET expires_at=consumed_at WHERE id=(a->>'otp')::uuid;
  c:=pg_temp.r10_claim(a);
  IF c->>'lookup_mode'<>'booking_reference' THEN RAISE EXCEPTION 'invalid SMS chronology accepted'; END IF;
  INSERT INTO qa_r10_results VALUES('expired-at-consumption SMS is not authority',true);
  a:=pg_temp.r10_operation('17035550114','sms');
  UPDATE public.booking_card_save_operations SET provider_material=jsonb_set(provider_material,'{client_phone}','"17035550999"') WHERE id=(a->>'operation')::uuid;
  c:=pg_temp.r10_claim(a);
  IF c->>'lookup_mode'<>'booking_reference' THEN RAISE EXCEPTION 'frozen phone mismatch accepted'; END IF;
  INSERT INTO qa_r10_results VALUES('frozen contact must match SMS and booking',true);

  a:=pg_temp.r10_operation('17035550115','sms'); c:=pg_temp.r10_claim(a);
  UPDATE public.phone_otp_sessions SET verified_channel='email' WHERE id=(a->>'otp')::uuid;
  r:=public.prepare_square_card_customer((a->>'operation')::uuid,(a->>'attempt')::uuid,(c->>'claim_id')::uuid,(c->>'lease_token')::uuid);
  IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'prepare accepted changed proof'; END IF;
  r:=pg_temp.r10_complete(a,c,'found','must_not_bind');
  IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'complete accepted changed proof'; END IF;
  INSERT INTO qa_r10_results VALUES('prepare and completion recheck phone authority',true);

  a:=pg_temp.r10_operation('17035550116','none'); b:=pg_temp.r10_operation('17035550117','none'); c:=pg_temp.r10_claim(a);
  r:=public.prepare_square_card_customer((b->>'operation')::uuid,(b->>'attempt')::uuid,(c->>'claim_id')::uuid,(c->>'lease_token')::uuid);
  IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'lease transferred to other operation'; END IF;
  r:=public.complete_square_card_customer((a->>'operation')::uuid,(a->>'attempt')::uuid,(c->>'claim_id')::uuid,fake,'found','must_not_bind');
  IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'wrong lease accepted'; END IF;
  UPDATE public.square_card_customer_claims SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=(c->>'claim_id')::uuid;
  r:=pg_temp.r10_complete(a,c,'found','must_not_bind');
  IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'stale lease accepted'; END IF;
  INSERT INTO qa_r10_results VALUES('wrong operation token and stale lease cannot complete',true);

  -- An old known contact can be inspected, never immediately reused. Alias
  -- verification changes only the v2 row; a safe negative read opens a new scope.
  a:=pg_temp.r10_operation('17035550120','none'); legacy:=extensions.gen_random_uuid();
  INSERT INTO public.square_card_customer_claims(id,salon_id,merchant_id,environment,contact_fingerprint,anchor_operation_id,
    request_material,reference_id,idempotency_key,status,customer_id)
    SELECT legacy,salon_id,expected_merchant_id,expected_environment,public.square_card_contact_fingerprint(provider_material,booking_id),id,
      provider_material,'nq-customer:'||legacy,'sqcu:'||legacy,'known','legacy_customer' FROM public.booking_card_save_operations WHERE id=(a->>'operation')::uuid;
  UPDATE public.booking_card_save_operations SET status='failed',completed_at=clock_timestamp(),result_json='{}',completion_fingerprint=repeat('c',64),error_code='square_customer_search_failed',customer_claim_id=legacy,expected_customer_id='legacy_customer' WHERE id=(a->>'operation')::uuid;
  SELECT to_jsonb(x) INTO old_row FROM public.square_card_customer_claims x WHERE id=legacy;
  b:=pg_temp.r10_operation('17035550120','none',(a->>'booking')::uuid); c:=pg_temp.r10_claim(b);
  IF c->>'code'<>'verify_known' OR c->>'lookup_mode'<>'legacy_reference' OR c->>'allow_create'<>'false'
    OR c->>'expected_customer_id'<>'legacy_customer' OR c->>'reference_id'<>old_row->>'reference_id' THEN RAISE EXCEPTION 'legacy known trusted without validation'; END IF;
  r:=pg_temp.r10_complete(b,c,'identity_not_authorized');
  IF r->>'code'<>'identity_retry_required' THEN RAISE EXCEPTION 'safe legacy rejection trapped booking: %',r; END IF;
  UPDATE public.booking_card_save_operations SET status='failed',completed_at=clock_timestamp(),result_json='{}',completion_fingerprint=repeat('c',64),error_code='square_customer_search_failed' WHERE id=(b->>'operation')::uuid;
  b:=pg_temp.r10_operation('17035550120','none',(a->>'booking')::uuid); d:=pg_temp.r10_claim(b);
  IF d->>'code'<>'claimed_v2' OR d->>'lookup_mode'<>'booking_reference' OR d->>'reference_id'=old_row->>'reference_id'
    OR d->'request_material'->>'client_phone' IS NOT NULL
    OR (SELECT to_jsonb(x) FROM public.square_card_customer_claims x WHERE id=legacy) IS DISTINCT FROM old_row THEN
    RAISE EXCEPTION 'legacy rejection changed history or reused rejected identity'; END IF;
  INSERT INTO qa_r10_results VALUES('legacy negative validation preserves row and permits safe fresh attempt',true);
  b:=pg_temp.r10_operation('17035550120','none'); d:=pg_temp.r10_claim(b);
  IF d->>'lookup_mode'<>'booking_reference' OR d->>'expected_customer_id' IS NOT NULL THEN RAISE EXCEPTION 'legacy shared contact crossed booking'; END IF;
  INSERT INTO qa_r10_results VALUES('legacy contact does not authorize another unverified booking',true);
  b:=pg_temp.r10_operation('17035550120','sms'); d:=pg_temp.r10_claim(b);
  IF d->>'code'<>'verify_known' OR d->>'lookup_mode'<>'legacy_phone' THEN RAISE EXCEPTION 'SMS legacy must require exact customer phone read'; END IF;
  INSERT INTO qa_r10_results VALUES('legacy cross-booking requires provider phone validation',true);

  -- Unknown references retain the prior key/body and their observation budget.
  a:=pg_temp.r10_operation('17035550121','none'); legacy:=extensions.gen_random_uuid();
  INSERT INTO public.square_card_customer_claims(id,salon_id,merchant_id,environment,contact_fingerprint,anchor_operation_id,
    request_material,reference_id,idempotency_key,status,dispatch_prepared_at,empty_read_count,lease_token,lease_expires_at)
    SELECT legacy,salon_id,expected_merchant_id,expected_environment,public.square_card_contact_fingerprint(provider_material,booking_id),id,
      provider_material,'nq-customer:'||legacy,'sqcu:'||legacy,'unknown',clock_timestamp()-interval '20 minutes',2,
      extensions.gen_random_uuid(),clock_timestamp()+interval '1 minute' FROM public.booking_card_save_operations WHERE id=(a->>'operation')::uuid;
  UPDATE public.booking_card_save_operations SET status='failed',completed_at=clock_timestamp(),result_json='{}',completion_fingerprint=repeat('c',64),error_code='square_customer_search_failed',customer_claim_id=legacy WHERE id=(a->>'operation')::uuid;
  b:=pg_temp.r10_operation('17035550121','none',(a->>'booking')::uuid); c:=pg_temp.r10_claim(b);
  IF c->>'code'<>'customer_wait' THEN RAISE EXCEPTION 'active legacy lease was forked'; END IF;
  UPDATE public.square_card_customer_claims SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=legacy;
  SELECT to_jsonb(x) INTO old_row FROM public.square_card_customer_claims x WHERE id=legacy;
  c:=pg_temp.r10_claim(b);scope_claim:=(c->>'claim_id')::uuid;
  IF c->>'code'<>'claimed_v2' OR c->>'previously_dispatched'<>'true' OR c->>'allow_create'<>'false'
    OR c->>'reference_id'<>old_row->>'reference_id' OR c->>'idempotency_key'<>old_row->>'idempotency_key'
    OR c->'request_material' IS DISTINCT FROM old_row->'request_material' THEN RAISE EXCEPTION 'unknown material forked'; END IF;
  r:=pg_temp.r10_complete(b,c,'read_failed');
  IF (SELECT empty_read_count FROM public.square_card_customer_claims WHERE id=scope_claim)<>2 THEN RAISE EXCEPTION 'failed read consumed budget'; END IF;
  UPDATE public.square_card_customer_claims SET next_read_at=clock_timestamp()-interval '1 second' WHERE id=scope_claim;
  c:=pg_temp.r10_claim(b);r:=pg_temp.r10_complete(b,c,'not_found');
  IF r->>'code'<>'ready' THEN RAISE EXCEPTION 'safe exhaustion did not become ready'; END IF;
  c:=pg_temp.r10_claim(b);
  IF c->>'allow_create'<>'true' OR c->>'previously_dispatched'<>'true' OR c->>'lookup_mode'<>'legacy_reference'
    OR c->>'reference_id'<>old_row->>'reference_id' OR c->>'idempotency_key'<>old_row->>'idempotency_key'
    OR c->'request_material' IS DISTINCT FROM old_row->'request_material'
    OR (SELECT to_jsonb(x) FROM public.square_card_customer_claims x WHERE id=legacy) IS DISTINCT FROM old_row THEN
    RAISE EXCEPTION 'exhaustion changed original delivery identity'; END IF;
  INSERT INTO qa_r10_results VALUES('unknown lease read budget and exhausted retry preserve exact legacy material',true);

  -- NULL legacy version must not accidentally pass a SQL three-valued predicate.
  a:=pg_temp.r10_operation('17035550122','none');
  UPDATE public.booking_card_save_operations SET status='failed',completed_at=clock_timestamp(),result_json='{}',completion_fingerprint=repeat('c',64),error_code='square_customer_search_failed',customer_delivery_version=NULL WHERE id=(a->>'operation')::uuid;
  IF public.square_card_prior_attempts_terminal((a->>'booking')::uuid,fake) THEN RAISE EXCEPTION 'ambiguous legacy failure treated terminal'; END IF;
  UPDATE public.booking_card_save_operations SET customer_delivery_version=1 WHERE id=(a->>'operation')::uuid;
  IF NOT public.square_card_prior_attempts_terminal((a->>'booking')::uuid,fake) THEN RAISE EXCEPTION 'proven pre-card failure trapped'; END IF;
  UPDATE public.booking_card_save_operations SET card_dispatch_bound_at=clock_timestamp() WHERE id=(a->>'operation')::uuid;
  IF public.square_card_prior_attempts_terminal((a->>'booking')::uuid,fake) THEN RAISE EXCEPTION 'unproved card failure treated terminal'; END IF;
  INSERT INTO public.booking_card_delivery_events(operation_id,booking_id,salon_id,provider,stage,code,retryability)
    VALUES((a->>'operation')::uuid,(a->>'booking')::uuid,(a->>'salon')::uuid,'square','card_create','square_card_create_failed','new_card');
  IF NOT public.square_card_prior_attempts_terminal((a->>'booking')::uuid,fake) THEN RAISE EXCEPTION 'definitive decline trapped'; END IF;
  INSERT INTO qa_r10_results VALUES('retry eligibility needs terminal evidence including legacy NULL safety',true);

  -- Cutover: the old contact-shared claim can be anchored to booking A while
  -- an earlier operation for booking B already references it. B may not fork
  -- the unresolved provider key, or use the contact as identity authority.
  a:=pg_temp.r10_operation('17035550130','none'); legacy:=pg_temp.r10_legacy(a,true);
  SELECT to_jsonb(x) INTO old_row FROM public.square_card_customer_claims x WHERE id=legacy;
  b:=pg_temp.r10_operation('17035550130','none'); PERFORM pg_temp.r10_fail(b,legacy);
  current_op:=pg_temp.r10_operation('17035550130','none',(b->>'booking')::uuid); c:=pg_temp.r10_claim(current_op);
  IF c->>'code' IS DISTINCT FROM 'verify_known' OR c->>'lookup_mode' IS DISTINCT FROM 'legacy_reference'
    OR c->>'reference_authorized' IS DISTINCT FROM 'false' OR c->>'allow_create' IS DISTINCT FROM 'false'
    OR c->>'reference_id' IS DISTINCT FROM old_row->>'reference_id'
    OR c->>'idempotency_key' IS DISTINCT FROM old_row->>'idempotency_key' THEN
    RAISE EXCEPTION 'foreign attached known claim did not retain the safe authority tuple: %',c; END IF;
  r:=pg_temp.r10_complete(current_op,c,'found',old_row->>'customer_id');
  IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'foreign reference incorrectly authorized identity'; END IF;
  r:=pg_temp.r10_complete(current_op,c,'identity_not_authorized');
  IF r->>'code' IS DISTINCT FROM 'identity_retry_required' THEN RAISE EXCEPTION 'foreign negative cannot recover'; END IF;
  PERFORM pg_temp.r10_fail(current_op);
  current_op:=pg_temp.r10_operation('17035550130','none',(b->>'booking')::uuid); d:=pg_temp.r10_claim(current_op);
  IF d->>'lookup_mode' IS DISTINCT FROM 'booking_reference' OR d->>'reference_authorized' IS DISTINCT FROM 'true'
    OR d->>'reference_id'=old_row->>'reference_id' OR d->'request_material'->>'client_phone' IS NOT NULL
    OR (SELECT to_jsonb(x) FROM public.square_card_customer_claims x WHERE id=legacy) IS DISTINCT FROM old_row THEN
    RAISE EXCEPTION 'foreign rejection changed history or permanently trapped fresh scoped recovery'; END IF;
  INSERT INTO qa_r10_results VALUES('historically attached foreign known claim is read-only then recoverable',true);

  a:=pg_temp.r10_operation('17035550131','none'); legacy:=pg_temp.r10_legacy(a,false);
  SELECT to_jsonb(x) INTO old_row FROM public.square_card_customer_claims x WHERE id=legacy;
  b:=pg_temp.r10_operation('17035550131','none'); PERFORM pg_temp.r10_fail(b,legacy);
  current_op:=pg_temp.r10_operation('17035550131','none',(b->>'booking')::uuid); c:=pg_temp.r10_claim(current_op);
  IF c->>'code' IS DISTINCT FROM 'claimed_v2' OR c->>'lookup_mode' IS DISTINCT FROM 'legacy_reference'
    OR c->>'reference_authorized' IS DISTINCT FROM 'false' OR c->>'allow_create' IS DISTINCT FROM 'false'
    OR c->>'previously_dispatched' IS DISTINCT FROM 'true' OR c->'request_material' IS DISTINCT FROM old_row->'request_material' THEN
    RAISE EXCEPTION 'foreign attached unknown claim forked or exposed invalid tuple'; END IF;
  r:=pg_temp.r10_complete(current_op,c,'read_failed');
  IF (SELECT empty_read_count FROM public.square_card_customer_claims WHERE id=(c->>'claim_id')::uuid)<>2 THEN
    RAISE EXCEPTION 'foreign read failure exhausted budget'; END IF;
  UPDATE public.square_card_customer_claims SET next_read_at=clock_timestamp()-interval '1 second' WHERE id=(c->>'claim_id')::uuid;
  c:=pg_temp.r10_claim(current_op);r:=pg_temp.r10_complete(current_op,c,'not_found');
  IF r->>'code' IS DISTINCT FROM 'identity_retry_required'
    OR (SELECT identity_rejected_at FROM public.square_card_customer_claims WHERE id=(c->>'claim_id')::uuid) IS NULL
    OR (SELECT to_jsonb(x) FROM public.square_card_customer_claims x WHERE id=legacy) IS DISTINCT FROM old_row THEN
    RAISE EXCEPTION 'foreign empty-read policy lost old history or opened unsafe CreateCustomer'; END IF;
  INSERT INTO qa_r10_results VALUES('foreign unknown key is fenced until the full empty-read policy',true);

  a:=pg_temp.r10_operation('17035550132','none'); legacy:=pg_temp.r10_legacy(a,false);
  a:=pg_temp.r10_operation('17035550133','none'); legacy2:=pg_temp.r10_legacy(a,false);
  b:=pg_temp.r10_operation('17035550132','none');PERFORM pg_temp.r10_fail(b,legacy);
  current_op:=pg_temp.r10_operation('17035550132','none',(b->>'booking')::uuid);PERFORM pg_temp.r10_fail(current_op,legacy2);
  current_op:=pg_temp.r10_operation('17035550132','none',(b->>'booking')::uuid);c:=pg_temp.r10_claim(current_op);
  IF c->>'code' IS DISTINCT FROM 'legacy_customer_review_required'
    OR (SELECT customer_claim_id FROM public.booking_card_save_operations WHERE id=(current_op->>'operation')::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'multiple historically attached provider keys silently chose one'; END IF;
  INSERT INTO qa_r10_results VALUES('multiple prior attached customer references stay fenced',true);

  -- Database is the last cutover boundary: a stale server with an old customer
  -- ID cannot bind it before CreateCard, even with a valid operation attempt.
  a:=pg_temp.r10_operation('17035550134','none');
  r:=public.bind_booking_card_save_dispatch((a->>'operation')::uuid,(a->>'attempt')::uuid,'customer_unproved','merchant_r10','sandbox');
  IF r->>'code' IS DISTINCT FROM 'customer_identity_unverified' THEN RAISE EXCEPTION 'unproved customer passed dispatch gate'; END IF;
  c:=pg_temp.r10_claim(a);r:=pg_temp.r10_complete(a,c,'found','customer_bound');
  r:=public.bind_booking_card_save_dispatch((a->>'operation')::uuid,(a->>'attempt')::uuid,'customer_wrong','merchant_r10','sandbox');
  IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'wrong known customer passed dispatch gate'; END IF;
  r:=public.bind_booking_card_save_dispatch((a->>'operation')::uuid,(a->>'attempt')::uuid,'customer_bound','other_merchant','sandbox');
  IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'cross account passed dispatch gate'; END IF;
  r:=public.bind_booking_card_save_dispatch((a->>'operation')::uuid,(a->>'attempt')::uuid,'customer_bound','merchant_r10','sandbox');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'valid v2 customer failed dispatch gate'; END IF;
  INSERT INTO qa_r10_results VALUES('dispatch gate rejects unproved mismatched and cross-account customers',true);
  a:=pg_temp.r10_operation('17035550135','sms');c:=pg_temp.r10_claim(a);r:=pg_temp.r10_complete(a,c,'found','customer_sms_gate');
  UPDATE public.phone_otp_sessions SET verified_channel='email' WHERE id=(a->>'otp')::uuid;
  r:=public.bind_booking_card_save_dispatch((a->>'operation')::uuid,(a->>'attempt')::uuid,'customer_sms_gate','merchant_r10','sandbox');
  IF r->>'code' IS DISTINCT FROM 'customer_identity_unverified' THEN RAISE EXCEPTION 'dispatch ignored revoked phone authority'; END IF;
  INSERT INTO qa_r10_results VALUES('dispatch gate rechecks current phone proof',true);

  a:=pg_temp.r10_operation('17035550136','none');legacy:=pg_temp.r10_legacy(a,true);
  UPDATE public.booking_card_save_operations SET expected_customer_id='legacy_inherited' WHERE id=(a->>'operation')::uuid;
  SELECT to_jsonb(x) INTO old_row FROM public.booking_card_save_operations x WHERE id=(a->>'operation')::uuid;
  UPDATE public.booking_management_capabilities SET revoked_at=clock_timestamp(),revoke_reason='card_delivery_settled' WHERE id=(a->>'capability')::uuid;
  c:=public.mint_booking_management_capability((a->>'salon')::uuid,(a->>'booking')::uuid,'card_manage',now()+interval '25 minutes');
  r:=public.claim_booking_card_save_operation((c->>'token_id')::uuid,extensions.gen_random_uuid(),'square','save_card',repeat('d',64));
  IF r->>'code' IS DISTINCT FROM 'claimed' OR r->>'attempt_replay' IS DISTINCT FROM 'false'
    OR (SELECT expected_customer_id FROM public.booking_card_save_operations WHERE id=(r->>'operation_id')::uuid) IS NOT NULL
    OR (SELECT to_jsonb(x) FROM public.booking_card_save_operations x WHERE id=(a->>'operation')::uuid) IS DISTINCT FROM old_row THEN
    RAISE EXCEPTION 'fresh operation did not clear unsafe inherited customer while preserving prior history'; END IF;
  INSERT INTO qa_r10_results VALUES('actual card-operation wrapper clears inherited ID only on a fresh terminal-safe attempt',true);
  a:=pg_temp.r10_operation('17035550137','none');
  UPDATE public.booking_management_capabilities SET revoked_at=clock_timestamp(),revoke_reason='card_delivery_settled' WHERE id=(a->>'capability')::uuid;
  c:=public.mint_booking_management_capability((a->>'salon')::uuid,(a->>'booking')::uuid,'card_manage',now()+interval '25 minutes');
  r:=public.claim_booking_card_save_operation((c->>'token_id')::uuid,extensions.gen_random_uuid(),'square','save_card',repeat('d',64));
  IF r->>'code' IS DISTINCT FROM 'reconciliation_required' THEN RAISE EXCEPTION 'new operation bypassed old unknown card fence'; END IF;
  INSERT INTO qa_r10_results VALUES('actual operation wrapper keeps an unresolved older attempt fenced',true);

  -- The existing-card receipt attachment calls a private no-provider binder;
  -- it remains atomic and idempotent without exposing a dispatch bypass RPC.
  a:=pg_temp.r10_operation('17035550138','none');PERFORM pg_temp.r10_fail(a);
  UPDATE public.booking_management_capabilities SET revoked_at=clock_timestamp(),revoke_reason='card_delivery_settled' WHERE id=(a->>'capability')::uuid;
  c:=jsonb_build_object('v',2,'receiptSource','existing_card_read','feeCents',500,'policyVersion','nsp_'||repeat('a',64),
    'scope','booking_member','policyEn','Synthetic policy','policyVi','Synthetic policy','source','fresh_consent');
  r:=public.record_booking_existing_square_card(p_booking_id=>(a->>'booking')::uuid,p_salon_id=>(a->>'salon')::uuid,
    p_customer_id=>'customer_existing_r10',p_card_id=>'card_existing_r10',p_merchant_id=>'merchant_r10',p_environment=>'sandbox',
    p_brand=>'VISA',p_last4=>'1111',p_consent_meta=>c);
  IF r->>'ok' IS DISTINCT FROM 'true' OR (SELECT public.booking_card_protection_state(x) FROM public.bookings x WHERE id=(a->>'booking')::uuid)<>'saved' THEN
    RAISE EXCEPTION 'atomic existing-card receipt compatibility failed: %',r; END IF;
  d:=public.record_booking_existing_square_card(p_booking_id=>(a->>'booking')::uuid,p_salon_id=>(a->>'salon')::uuid,
    p_customer_id=>'customer_existing_r10',p_card_id=>'card_existing_r10',p_merchant_id=>'merchant_r10',p_environment=>'sandbox',
    p_brand=>'VISA',p_last4=>'1111',p_consent_meta=>c);
  IF d->>'idempotent' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'existing-card receipt replay failed'; END IF;
  INSERT INTO qa_r10_results VALUES('existing-card receipt remains atomic and idempotent through a private binder',true);

  IF has_function_privilege('anon','public.claim_square_card_customer(uuid,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.claim_square_card_customer(uuid,uuid)','EXECUTE')
    OR has_function_privilege('service_role','public.square_card_booking_phone_authorized(uuid,uuid,jsonb)','EXECUTE')
    OR has_function_privilege('service_role','public.square_card_prior_attempts_terminal(uuid,uuid)','EXECUTE')
    OR has_function_privilege('service_role','public.bind_booking_existing_card_receipt(uuid,uuid,text,text,text)','EXECUTE')
    OR has_table_privilege('authenticated','public.square_card_customer_claims','SELECT')
    OR has_table_privilege('service_role','public.square_card_customer_claims','UPDATE') THEN RAISE EXCEPTION 'authority ACL drift'; END IF;
  INSERT INTO qa_r10_results VALUES('private helper and claim ACLs remain least privilege',true);
END;$tests$;
SELECT jsonb_build_object('status','PASS','cases',count(*),'results',jsonb_agg(scenario ORDER BY scenario)) FROM qa_r10_results;
ROLLBACK;
