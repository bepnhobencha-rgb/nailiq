\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('request.jwt.claim.role','service_role',true);

DO $rehearsal$
DECLARE
  v_salon uuid := '15150000-0000-4000-8000-000000000001';
  v_service uuid := '15150000-0000-4000-8000-000000000002';
  v_staff uuid := '15150000-0000-4000-8000-000000000003';
  v_start timestamptz := date_trunc('hour',now()) + interval '2 days';
  v_end timestamptz := date_trunc('hour',now()) + interval '2 days 30 minutes';
  v_material jsonb;
  v_result jsonb;
  v_due jsonb;
  v_attempt uuid;
  v_operation uuid;
  v_booking uuid;
  v_intent uuid;
  v_request uuid;
  v_fp text := repeat('a',64);
  v_account_fp text := repeat('b',64);
  v_i integer := 0;
BEGIN
  INSERT INTO public.service_categories(slug,name_en,name_vi)
  VALUES ('payment-operation-rehearsal','Payment operation rehearsal','Payment operation rehearsal');
  INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code)
  VALUES (v_salon,'payment-operation-rehearsal','Payment operation rehearsal',
    '+16045550151','UTC','CAD');
  INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
  VALUES (v_service,v_salon,'Payment rehearsal service',5000,30,'payment-operation-rehearsal');
  INSERT INTO public.staff(id,salon_id,name,status,deleted_at)
  VALUES (v_staff,v_salon,'Payment rehearsal staff','active',NULL);
  INSERT INTO auth.users(id,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at) VALUES
   ('15150000-0000-4000-8000-000000000004','payment-desk@nailiq.invalid','',now(),
    '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now()),
   ('15150000-0000-4000-8000-000000000005','payment-desk-two@nailiq.invalid','',now(),
    '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now());
  INSERT INTO public.salon_members(salon_id,user_id,role) VALUES
   (v_salon,'15150000-0000-4000-8000-000000000004','owner'),
   (v_salon,'15150000-0000-4000-8000-000000000005','senior');

  -- Canonical successful bind.
  v_operation := '15150000-0000-4000-8000-000000000010';
  v_request := '15150000-0000-4000-8000-000000000011';
  v_intent := '15150000-0000-4000-8000-000000000012';
  v_booking := '15150000-0000-4000-8000-000000000013';
  v_material := jsonb_build_object('deposit_reason','qa','amount_cents',1000);
  INSERT INTO public.booking_payment_operations(
    id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,
    amount_cents,currency,material_fingerprint,material_json,provider_material,
    booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,
    start_time_utc,end_time_utc,client_phone_fingerprint,parent_payment_id,
    provider_payment_id,provider_idempotency_key,status,result_json,completed_at,
    binding_expires_at,unbound_compensation_due_at
  ) VALUES (
    v_operation,v_salon,v_request,'deposit_charge','stripe',v_account_fp,
    1000,'CAD',v_fp,v_material,'{}',v_intent,repeat('c',64),v_service,v_staff,
    v_start,v_end,encode(extensions.digest(convert_to(public.canonical_phone('+16045550152'),'UTF8'),'sha256'),'hex'),
    NULL,'pi_payment_rehearsal_bind','nq:'||v_operation::text,'succeeded',
    jsonb_build_object('status','succeeded'),now(),now()+interval '10 minutes',now()+interval '10 minutes'
  );
  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,
    status,idempotency_key,public_booking_pricing_fingerprint
  ) VALUES (
    v_booking,v_salon,v_service,v_staff,'Payment QA','+16045550152',v_start,v_end,
    'confirmed',v_intent,repeat('c',64)
  );
  v_result:=public.bind_public_deposit_payment_operation(v_operation,v_request,v_fp,v_booking);
  IF v_result->>'code'<>'bound' THEN RAISE EXCEPTION 'canonical bind failed: %',v_result; END IF;
  IF (SELECT deposit_status FROM public.bookings WHERE id=v_booking)<>'paid' THEN
    RAISE EXCEPTION 'canonical bind did not persist paid state';
  END IF;
  v_result:=public.bind_public_deposit_payment_operation(v_operation,v_request,v_fp,v_booking);
  IF v_result->>'code'<>'binding_replay' THEN RAISE EXCEPTION 'bind replay failed: %',v_result; END IF;

  -- Binding cannot adopt cancelled, grouped, soft-deleted, or expired rows.
  -- Linked archived recovery is hard-off in V1 and has its own rejection
  -- rehearsal, so this payment fixture no longer creates a recovery child.
  FOREACH v_i IN ARRAY ARRAY[1,2,3,5] LOOP
    v_start:=v_start+interval '1 hour';
    v_end:=v_end+interval '1 hour';
    v_operation:=('15150000-0000-4000-8000-'||lpad((100+v_i)::text,12,'0'))::uuid;
    v_request:=('15150000-0000-4000-8000-'||lpad((200+v_i)::text,12,'0'))::uuid;
    v_intent:=('15150000-0000-4000-8000-'||lpad((300+v_i)::text,12,'0'))::uuid;
    v_booking:=('15150000-0000-4000-8000-'||lpad((400+v_i)::text,12,'0'))::uuid;
    INSERT INTO public.booking_payment_operations(
      id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,
      amount_cents,currency,material_fingerprint,material_json,provider_material,
      booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,
      start_time_utc,end_time_utc,client_phone_fingerprint,provider_payment_id,
      provider_idempotency_key,status,result_json,completed_at,binding_expires_at,
      unbound_compensation_due_at
    ) VALUES (
      v_operation,v_salon,v_request,'deposit_charge','stripe',v_account_fp,
      1000,'CAD',v_fp,v_material,'{}',v_intent,repeat('c',64),v_service,v_staff,
      v_start,v_end,encode(extensions.digest(convert_to(public.canonical_phone('+16045550'||lpad(v_i::text,3,'0')),'UTF8'),'sha256'),'hex'),
      'pi_payment_rehearsal_negative_'||v_i,'nq:'||v_operation::text,'succeeded',
      jsonb_build_object('status','succeeded'),now(),
      CASE WHEN v_i=5 THEN now()-interval '1 second' ELSE now()+interval '10 minutes' END,
      now()+interval '10 minutes'
    );
    INSERT INTO public.bookings(
      id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,
      status,idempotency_key,public_booking_pricing_fingerprint,group_id,deleted_at,
      recovered_from_booking_id,recovery_kind,recovered_by_user_id
    ) VALUES (
      v_booking,v_salon,v_service,v_staff,'Negative QA','+16045550'||lpad(v_i::text,3,'0'),v_start,v_end,
      CASE WHEN v_i=1 THEN 'cancelled' ELSE 'confirmed' END,v_intent,repeat('c',64),
      CASE WHEN v_i=2 THEN gen_random_uuid() END,
      CASE WHEN v_i=3 THEN now() END,
      NULL,NULL,NULL
    );
    v_result:=public.bind_public_deposit_payment_operation(v_operation,v_request,v_fp,v_booking);
    IF v_i<5 AND v_result->>'code'<>'booking_not_bindable' THEN
      RAISE EXCEPTION 'lifecycle bind % was not rejected: %',v_i,v_result;
    ELSIF v_i=5 AND v_result->>'code'<>'binding_expired' THEN
      RAISE EXCEPTION 'expired bind was not rejected: %',v_result;
    END IF;
  END LOOP;

  -- Paid-but-abandoned discovery, stable lease request, compensation, and
  -- release of active intent ownership after the exact refund succeeds.
  v_operation:='15150000-0000-4000-8000-000000000510';
  v_request:='15150000-0000-4000-8000-000000000511';
  v_intent:='15150000-0000-4000-8000-000000000512';
  INSERT INTO public.booking_payment_operations(
    id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,
    amount_cents,currency,material_fingerprint,material_json,provider_material,
    booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,
    start_time_utc,end_time_utc,client_phone_fingerprint,provider_payment_id,
    provider_idempotency_key,status,result_json,completed_at,binding_expires_at,
    unbound_compensation_due_at
  ) VALUES (
    v_operation,v_salon,v_request,'deposit_charge','stripe',v_account_fp,
    1200,'CAD',repeat('d',64),jsonb_build_object('amount_cents',1200),
    jsonb_build_object('provider','stripe'),v_intent,repeat('e',64),v_service,v_staff,
    v_start,v_end,repeat('f',64),'pi_payment_rehearsal_abandoned',
    'nq:'||v_operation::text,'succeeded',jsonb_build_object('status','succeeded'),now(),
    now()-interval '1 second',now()-interval '1 second'
  );
  SELECT x INTO v_due FROM public.discover_due_unbound_deposit_compensations(1) x;
  IF v_due->>'parent_operation_id'<>v_operation::text THEN
    RAISE EXCEPTION 'due compensation discovery failed: %',v_due;
  END IF;
  v_result:=public.claim_due_unbound_deposit_refund(
    v_operation,(v_due->>'lease_token')::uuid,v_due->>'material_fingerprint'
  );
  IF v_result->>'code'<>'claimed' THEN RAISE EXCEPTION 'due compensation claim failed: %',v_result; END IF;
  v_attempt:=(v_result->>'attempt_token')::uuid;
  v_result:=public.complete_booking_payment_operation(
    (v_result->>'operation_id')::uuid,v_attempt,'succeeded','succeeded',NULL,
    're_payment_rehearsal_compensation',NULL
  );
  IF v_result->>'code'<>'compensated' THEN RAISE EXCEPTION 'compensation completion failed: %',v_result; END IF;
  IF (SELECT status FROM public.booking_payment_operations WHERE id=v_operation)<>'compensated' THEN
    RAISE EXCEPTION 'parent not terminal compensated';
  END IF;
  INSERT INTO public.booking_payment_operations(
    salon_id,request_id,operation_kind,provider,provider_account_fingerprint,
    amount_cents,currency,material_fingerprint,material_json,provider_material,
    booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,
    start_time_utc,end_time_utc,client_phone_fingerprint,provider_idempotency_key
  ) VALUES (
    v_salon,gen_random_uuid(),'deposit_charge','stripe',v_account_fp,1200,'CAD',repeat('1',64),
    '{}'::jsonb,'{}'::jsonb,v_intent,repeat('2',64),v_service,v_staff,v_start,v_end,
    repeat('3',64),'nq:'||gen_random_uuid()::text
  );

  -- A definite pre-acceptance refund rejection is retryable as a new durable
  -- compensation child; ambiguous/unknown children remain reserved forever.
  v_operation:='15150000-0000-4000-8000-000000000550';
  INSERT INTO public.booking_payment_operations(
    id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,
    amount_cents,currency,material_fingerprint,material_json,provider_material,
    booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,
    start_time_utc,end_time_utc,client_phone_fingerprint,provider_payment_id,
    provider_idempotency_key,status,result_json,completed_at,binding_expires_at,
    unbound_compensation_due_at
  ) VALUES (
    v_operation,v_salon,gen_random_uuid(),'deposit_charge','stripe',v_account_fp,
    900,'CAD',repeat('a',64),'{}','{}',gen_random_uuid(),repeat('b',64),v_service,v_staff,
    v_start,v_end,repeat('c',64),'pi_payment_rehearsal_retryable_compensation',
    'nq:'||v_operation::text,'succeeded','{}',now(),now()-interval '1 second',now()-interval '1 second'
  );
  SELECT x INTO v_due FROM public.discover_due_unbound_deposit_compensations(1) x;
  v_request:=(v_due->>'request_id')::uuid;
  v_result:=public.claim_due_unbound_deposit_refund(
    v_operation,(v_due->>'lease_token')::uuid,v_due->>'material_fingerprint'
  );
  v_result:=public.complete_booking_payment_operation(
    (v_result->>'operation_id')::uuid,(v_result->>'attempt_token')::uuid,
    'definite_failure','rejected',NULL,NULL,'provider_rejected'
  );
  IF v_result->>'code'<>'definite_failure' THEN RAISE EXCEPTION 'compensation rejection failed: %',v_result; END IF;
  SELECT x INTO v_due FROM public.discover_due_unbound_deposit_compensations(1) x;
  IF v_due->>'parent_operation_id'<>v_operation::text
     OR (v_due->>'request_id')::uuid=v_request THEN
    RAISE EXCEPTION 'failed compensation was not safely re-leased: %',v_due;
  END IF;
  v_result:=public.claim_due_unbound_deposit_refund(
    v_operation,(v_due->>'lease_token')::uuid,v_due->>'material_fingerprint'
  );
  IF v_result->>'code'<>'claimed' THEN RAISE EXCEPTION 'replacement compensation claim failed: %',v_result; END IF;

  -- Expired browser bearer can resume only the same stored PaymentIntent.
  v_operation:='15150000-0000-4000-8000-000000000610';
  v_request:='15150000-0000-4000-8000-000000000611';
  v_intent:='15150000-0000-4000-8000-000000000612';
  INSERT INTO public.booking_payment_operations(
    id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,
    amount_cents,currency,material_fingerprint,material_json,provider_material,
    booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,
    start_time_utc,end_time_utc,client_phone_fingerprint,provider_payment_id,
    provider_status,provider_idempotency_key,status,customer_finalize_token_hash,
    customer_finalize_expires_at
  ) VALUES (
    v_operation,v_salon,v_request,'deposit_charge','stripe',v_account_fp,1000,'CAD',repeat('4',64),
    '{}'::jsonb,'{}'::jsonb,v_intent,repeat('5',64),v_service,v_staff,v_start,v_end,
    repeat('6',64),'pi_payment_rehearsal_resume','requires_action','nq:'||v_operation::text,
    'pending_customer',repeat('7',64),now()-interval '1 second'
  );
  v_result:=public.resume_public_deposit_customer_confirmation(
    v_operation,v_request,repeat('4',64),'pi_payment_rehearsal_resume',
    'requires_action',NULL,'stable-finalize-token-payment-qa'
  );
  IF v_result->>'code'<>'customer_confirmation_resumed'
     OR (v_result->>'finalize_expires_at')::timestamptz<=now() THEN
    RAISE EXCEPTION 'same PI resume failed: %',v_result;
  END IF;
  v_result:=public.resume_public_deposit_customer_confirmation(
    v_operation,v_request,repeat('4',64),'pi_wrong_intent','requires_action',NULL,
    'stable-finalize-token-payment-qa'
  );
  IF v_result->>'code'<>'operation_conflict' THEN RAISE EXCEPTION 'wrong PI was accepted: %',v_result; END IF;

  -- Explicit terminal card failure releases the intent for a deliberate new request.
  v_result:=public.resume_public_deposit_customer_confirmation(
    v_operation,v_request,repeat('4',64),'pi_payment_rehearsal_resume',
    'requires_payment_method','expired_card','stable-finalize-token-payment-qa'
  );
  IF v_result->>'code'<>'definite_failure' THEN RAISE EXCEPTION 'terminal resume failed: %',v_result; END IF;
  INSERT INTO public.booking_payment_operations(
    salon_id,request_id,operation_kind,provider,provider_account_fingerprint,
    amount_cents,currency,material_fingerprint,material_json,provider_material,
    booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,
    start_time_utc,end_time_utc,client_phone_fingerprint,provider_idempotency_key
  ) VALUES (
    v_salon,gen_random_uuid(),'deposit_charge','stripe',v_account_fp,1000,'CAD',repeat('8',64),
    '{}'::jsonb,'{}'::jsonb,v_intent,repeat('9',64),v_service,v_staff,v_start,v_end,
    repeat('0',64),'nq:'||gen_random_uuid()::text
  );
END
$rehearsal$;

DO $late_cancel$
DECLARE
  v_salon uuid := '15150000-0000-4000-8000-000000000001';
  v_service uuid := '15150000-0000-4000-8000-000000000002';
  v_staff uuid := '15150000-0000-4000-8000-000000000003';
  v_booking uuid := '15150000-0000-4000-8000-000000000701';
  v_cap uuid := '15150000-0000-4000-8000-000000000702';
  v_request uuid := '15150000-0000-4000-8000-000000000703';
  v_loaded jsonb; v_result jsonb; v_attempt uuid; v_charge uuid;
  v_refund_loaded jsonb; v_refund jsonb;
BEGIN
  UPDATE public.salons SET payment_provider='stripe',
    stripe_connect_account_id='acct_payment_rehearsal',
    stripe_connect_charges_enabled=true,self_cancel_fee_enabled=true,
    self_cancel_window_hours=120 WHERE id=v_salon;
  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,
    status,noshow_card_id,noshow_customer_id,noshow_consent_at,noshow_charge_status,
    noshow_fee_cents
  ) VALUES (
    v_booking,v_salon,v_service,v_staff,'Late cancel QA','+16045550701',
    now()+interval '3 days',now()+interval '3 days 30 minutes','confirmed',
    'pm_late_cancel_qa','cus_late_cancel_qa',now(),'saved',1500
  );
  UPDATE public.bookings SET status='cancelled' WHERE id=v_booking;
  v_result:=public.load_booking_payment_operation_material(
    v_salon,v_booking,'late_cancel_charge',1500
  );
  IF v_result->>'code'<>'late_cancel_occurrence_not_authorized' THEN
    RAISE EXCEPTION 'generic staff cancel was charge-authorized without explicit proof: %',v_result;
  END IF;
  INSERT INTO public.booking_management_action_state(salon_id,booking_id,action,epoch)
  VALUES(v_salon,v_booking,'cancel',2);
  INSERT INTO public.booking_management_capabilities(
    id,salon_id,booking_id,action,scope_kind,epoch,booking_version,expires_at,
    consumed_at,revoke_reason,request_id,payload_fingerprint,result_json,result_fingerprint
  ) VALUES (
    v_cap,v_salon,v_booking,'cancel','booking_own',1,0,now()+interval '1 day',now(),
    'action_consumed',gen_random_uuid(),repeat('1',64),
    jsonb_build_object('ok',true,'status','cancelled','scope_kind','booking_own',
      'rsvp_semantic',NULL,'customer_transition_version',1,
      'cancel_preview',jsonb_build_object('will_charge',true,'has_chargeable_card',true,
        'within_window',true,'fee_cents',1500,'currency','CAD')),
    repeat('2',64)
  );
  v_loaded:=public.load_booking_payment_operation_material(
    v_salon,v_booking,'late_cancel_charge',1500
  );
  IF v_loaded->>'code'<>'material_loaded'
     OR (v_loaded->>'operation_occurrence_version')::bigint<>1 THEN
    RAISE EXCEPTION 'late cancel material failed: %',v_loaded;
  END IF;
  v_result:=public.claim_booking_payment_operation(
    v_salon,v_booking,v_request,'late_cancel_charge',1500,v_loaded->>'material_fingerprint'
  );
  IF v_result->>'code'<>'claimed' THEN RAISE EXCEPTION 'late cancel claim failed: %',v_result; END IF;
  v_charge:=(v_result->>'operation_id')::uuid; v_attempt:=(v_result->>'attempt_token')::uuid;
  v_result:=public.complete_booking_payment_operation(
    v_charge,v_attempt,'succeeded','succeeded','pi_late_cancel_rehearsal',NULL,NULL
  );
  IF v_result->>'code'<>'succeeded'
     OR v_result->'result'->>'late_cancel_charge_status'<>'charged'
     OR (v_result->'result'->>'operation_occurrence_version')::bigint<>1 THEN
    RAISE EXCEPTION 'late cancel completion failed: %',v_result;
  END IF;
  v_result:=public.claim_booking_payment_operation(
    v_salon,v_booking,v_request,'late_cancel_charge',1500,v_loaded->>'material_fingerprint'
  );
  IF v_result->>'code'<>'operation_replay' THEN RAISE EXCEPTION 'late cancel replay failed: %',v_result; END IF;

  -- Fair-cancel refund is tied to the exact late-cancel parent operation.
  v_result:=public.load_booking_payment_operation_material(
    v_salon,v_booking,'late_cancel_refund',600
  );
  IF v_result->>'code'<>'invalid_input' THEN RAISE EXCEPTION 'generic late refund loader accepted: %',v_result; END IF;
  v_result:=public.claim_booking_payment_operation(
    v_salon,v_booking,gen_random_uuid(),'late_cancel_refund',600,repeat('a',64)
  );
  IF v_result->>'code'<>'dedicated_late_cancel_refund_required' THEN
    RAISE EXCEPTION 'generic late refund claim accepted: %',v_result;
  END IF;
  v_refund_loaded:=public.load_late_cancel_refund_material(v_charge,600);
  v_refund:=public.claim_late_cancel_refund(
    v_charge,'15150000-0000-4000-8000-000000000704',600,
    v_refund_loaded->>'material_fingerprint'
  );
  v_result:=public.complete_booking_payment_operation(
    (v_refund->>'operation_id')::uuid,(v_refund->>'attempt_token')::uuid,
    'succeeded','succeeded',NULL,'re_late_cancel_partial_qa',NULL
  );
  IF v_result->'result'->>'late_cancel_refund_status'<>'partial' THEN
    RAISE EXCEPTION 'late cancel partial refund failed: %',v_result;
  END IF;

  -- Undo then cancel again has a new DB-owned transition version.  An unknown
  -- provider outcome reserves only that occurrence and cannot create another.
  v_result:=public.undo_recent_cancelled_booking_v1(
    v_booking,v_salon,'15150000-0000-4000-8000-000000000004','owner'
  );
  IF v_result->>'code'<>'cancel_undone' THEN
    RAISE EXCEPTION 'V1 immediate cancel undo failed: %',v_result;
  END IF;
  UPDATE public.bookings SET status='cancelled' WHERE id=v_booking;
  INSERT INTO public.booking_management_capabilities(
    salon_id,booking_id,action,scope_kind,epoch,booking_version,expires_at,
    consumed_at,revoke_reason,request_id,payload_fingerprint,result_json,result_fingerprint
  ) VALUES (
    v_salon,v_booking,'cancel','booking_own',2,2,now()+interval '1 day',now(),
    'action_consumed',gen_random_uuid(),repeat('3',64),
    jsonb_build_object('ok',true,'status','cancelled','scope_kind','booking_own',
      'rsvp_semantic',NULL,'customer_transition_version',3,
      'cancel_preview',jsonb_build_object('will_charge',true,'has_chargeable_card',true,
        'within_window',true,'fee_cents',1500,'currency','CAD')),
    repeat('4',64)
  );
  v_loaded:=public.load_booking_payment_operation_material(v_salon,v_booking,'late_cancel_charge',1500);
  IF (v_loaded->>'operation_occurrence_version')::bigint<>3 THEN
    RAISE EXCEPTION 'new cancel occurrence not resolved: %',v_loaded;
  END IF;
  v_result:=public.claim_booking_payment_operation(
    v_salon,v_booking,'15150000-0000-4000-8000-000000000705',
    'late_cancel_charge',1500,v_loaded->>'material_fingerprint'
  );
  v_result:=public.complete_booking_payment_operation(
    (v_result->>'operation_id')::uuid,(v_result->>'attempt_token')::uuid,
    'unknown','timeout',NULL,NULL,'provider_timeout'
  );
  IF v_result->>'code'<>'provider_outcome_unknown' THEN RAISE EXCEPTION 'ambiguous cancel not reserved: %',v_result; END IF;
  v_result:=public.claim_booking_payment_operation(
    v_salon,v_booking,'15150000-0000-4000-8000-000000000706',
    'late_cancel_charge',1500,v_loaded->>'material_fingerprint'
  );
  IF v_result->>'code'<>'reconciliation_required' THEN
    RAISE EXCEPTION 'same cancel occurrence duplicated after unknown: %',v_result;
  END IF;

  -- Group member/organizer RSVP decline can never authorize a fee charge.
  v_result:=public.undo_recent_cancelled_booking_v1(
    v_booking,v_salon,'15150000-0000-4000-8000-000000000004','owner'
  );
  IF v_result->>'code'<>'cancel_undone' THEN
    RAISE EXCEPTION 'V1 immediate cancel undo failed: %',v_result;
  END IF;
  UPDATE public.bookings SET group_id=gen_random_uuid() WHERE id=v_booking;
  UPDATE public.bookings SET status='cancelled' WHERE id=v_booking;
  INSERT INTO public.booking_management_capabilities(
    salon_id,booking_id,action,scope_kind,epoch,booking_version,expires_at,
    consumed_at,revoke_reason,request_id,payload_fingerprint,result_json,result_fingerprint
  ) VALUES (
    v_salon,v_booking,'cancel','member_own',3,3,now()+interval '1 day',now(),
    'action_consumed',gen_random_uuid(),repeat('5',64),
    jsonb_build_object('ok',true,'status','cancelled','scope_kind','member_own',
      'rsvp_semantic','decline','customer_transition_version',4,
      'cancel_preview',jsonb_build_object('will_charge',true,'has_chargeable_card',true,
        'fee_cents',1500,'currency','CAD')),
    repeat('6',64)
  );
  v_result:=public.load_booking_payment_operation_material(v_salon,v_booking,'late_cancel_charge',1500);
  IF v_result->>'code'<>'late_cancel_occurrence_not_authorized' THEN
    RAISE EXCEPTION 'RSVP decline authorized a charge: %',v_result;
  END IF;
END
$late_cancel$;

DO $public_deposit_atomic$
DECLARE
  v_salon uuid := '15150000-0000-4000-8000-000000000001';
  v_service uuid := '15150000-0000-4000-8000-000000000002';
  v_staff uuid := '15150000-0000-4000-8000-000000000003';
  v_start timestamptz := date_trunc('day',now())+interval '12 days 12 hours';
  v_end timestamptz;
  v_quote jsonb;
  v_claim jsonb;
  v_replay jsonb;
  v_attach jsonb;
  v_finalize jsonb;
  v_complete jsonb;
  v_create jsonb;
  v_due jsonb;
  v_provider_material jsonb;
  v_operation uuid;
  v_request uuid := '15150000-0000-4000-8000-000000000801';
  v_intent uuid := '15150000-0000-4000-8000-000000000802';
  v_booking uuid;
  v_fp text;
  v_phone text := '+16045551801';
BEGIN
  UPDATE public.salons SET
    opening_hours='{
      "sun":{"open":"00:00","close":"23:59","closed":false},
      "mon":{"open":"00:00","close":"23:59","closed":false},
      "tue":{"open":"00:00","close":"23:59","closed":false},
      "wed":{"open":"00:00","close":"23:59","closed":false},
      "thu":{"open":"00:00","close":"23:59","closed":false},
      "fri":{"open":"00:00","close":"23:59","closed":false},
      "sat":{"open":"00:00","close":"23:59","closed":false}
    }'::jsonb,
    payment_provider='stripe',stripe_connect_account_id='acct_public_deposit_rehearsal',
    stripe_connect_charges_enabled=true,deposit_high_value_cents=1,
    deposit_pct_new_customer=20,archived_at=NULL
    WHERE id=v_salon;
  INSERT INTO public.staff_services(staff_id,service_id)
  VALUES(v_staff,v_service) ON CONFLICT DO NOTHING;
  UPDATE public.services SET price_cents=5000 WHERE id=v_service;
  v_end:=v_start+interval '40 minutes';
  v_quote:=public.quote_public_booking(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    v_phone,NULL,false
  );
  IF v_quote->>'success'<>'true' THEN RAISE EXCEPTION 'public deposit quote failed: %',v_quote; END IF;

  v_claim:=public.claim_public_deposit_payment_operation(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    v_phone,NULL,false,v_intent,v_quote->>'pricing_fingerprint',v_request
  );
  IF v_claim->>'code'<>'claimed' OR v_claim->'provider_material' IS NULL THEN
    RAISE EXCEPTION 'public deposit claim failed: %',v_claim;
  END IF;
  v_operation:=(v_claim->>'operation_id')::uuid;
  v_fp:=v_claim->>'material_fingerprint';
  v_provider_material:=v_claim->'provider_material';
  v_replay:=public.claim_public_deposit_payment_operation(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    v_phone,NULL,false,v_intent,v_quote->>'pricing_fingerprint',v_request
  );
  IF v_replay->>'code'<>'attempt_replay'
     OR v_replay->>'attempt_token' IS DISTINCT FROM v_claim->>'attempt_token'
     OR v_replay->'provider_material' IS DISTINCT FROM v_provider_material THEN
    RAISE EXCEPTION 'active attempt exact replay failed: %',v_replay;
  END IF;

  -- requires_action is a durable, resumable customer stage, never a booking.
  v_attach:=public.attach_public_deposit_provider_intent(
    v_operation,(v_claim->>'attempt_token')::uuid,'pi_public_deposit_rehearsal',
    'requires_action','public-deposit-finalize-token-0001'
  );
  IF v_attach->>'code'<>'intent_attached' OR v_attach->>'status'<>'pending_customer' THEN
    RAISE EXCEPTION 'requires_action was not retained: %',v_attach;
  END IF;
  UPDATE public.salons SET payment_provider=NULL,stripe_connect_charges_enabled=false
    WHERE id=v_salon;
  UPDATE public.services SET price_cents=7777 WHERE id=v_service;
  v_replay:=public.claim_public_deposit_payment_operation(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    v_phone,NULL,false,v_intent,v_quote->>'pricing_fingerprint',v_request
  );
  IF v_replay->>'code'<>'customer_confirmation_pending'
     OR v_replay->>'provider_payment_id'<>'pi_public_deposit_rehearsal'
     OR v_replay->'provider_material' IS DISTINCT FROM v_provider_material THEN
    RAISE EXCEPTION 'stored replay was hidden by live provider/pricing drift: %',v_replay;
  END IF;
  v_create:=public.create_public_booking_with_deposit_payment(
    v_salon,v_service,v_staff,'Paid QA',v_phone,v_start,v_end,'confirmed',NULL,
    ARRAY[]::uuid[],NULL,NULL,NULL,NULL,false,v_intent,v_quote->>'pricing_fingerprint',
    v_operation,v_request,v_fp
  );
  IF v_create->>'code'<>'payment_customer_action_required'
     OR EXISTS(SELECT 1 FROM public.bookings WHERE salon_id=v_salon AND idempotency_key=v_intent) THEN
    RAISE EXCEPTION 'pending customer stage created a booking: %',v_create;
  END IF;

  v_finalize:=public.claim_public_deposit_finalization(
    v_operation,v_request,'public-deposit-finalize-token-0001'
  );
  IF v_finalize->>'code'<>'finalization_claimed' THEN
    RAISE EXCEPTION 'public deposit finalization claim failed: %',v_finalize;
  END IF;
  v_complete:=public.complete_booking_payment_operation(
    v_operation,(v_finalize->>'attempt_token')::uuid,'succeeded','succeeded',
    'pi_public_deposit_rehearsal',NULL,NULL
  );
  IF v_complete->>'code'<>'succeeded_unbound' THEN
    RAISE EXCEPTION 'public deposit completion failed: %',v_complete;
  END IF;
  UPDATE public.salons SET payment_provider='stripe',stripe_connect_charges_enabled=true
    WHERE id=v_salon;
  UPDATE public.services SET price_cents=5000 WHERE id=v_service;
  v_create:=public.create_public_booking_with_deposit_payment(
    v_salon,v_service,v_staff,'Paid QA',v_phone,v_start,v_end,'confirmed',NULL,
    ARRAY[]::uuid[],NULL,NULL,NULL,NULL,false,v_intent,v_quote->>'pricing_fingerprint',
    v_operation,v_request,v_fp
  );
  IF v_create->>'code'<>'booked_and_deposit_bound' THEN
    RAISE EXCEPTION 'atomic booking+deposit failed: %',v_create;
  END IF;
  v_booking:=(v_create->>'booking_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.bookings b
      WHERE b.id=v_booking AND b.deposit_status='paid'
        AND b.stripe_payment_intent_id='pi_public_deposit_rehearsal')
     OR (SELECT booking_id FROM public.booking_payment_operations WHERE id=v_operation)<>v_booking THEN
    RAISE EXCEPTION 'atomic booking/payment persistence mismatch';
  END IF;

  -- Exact create+bind replay also precedes current salon/pricing lifecycle drift.
  UPDATE public.salons SET archived_at=now(),stripe_connect_charges_enabled=false WHERE id=v_salon;
  UPDATE public.services SET price_cents=8888 WHERE id=v_service;
  v_replay:=public.create_public_booking_with_deposit_payment(
    v_salon,v_service,v_staff,'Paid QA',v_phone,v_start,v_end,'confirmed',NULL,
    ARRAY[]::uuid[],NULL,NULL,NULL,NULL,false,v_intent,v_quote->>'pricing_fingerprint',
    v_operation,v_request,v_fp
  );
  IF v_replay->>'code'<>'booking_payment_replay'
     OR v_replay->>'booking_id'<>v_booking::text
     OR v_replay->'payment_result'->'booking_create_result' IS DISTINCT FROM v_create->'booking' THEN
    RAISE EXCEPTION 'atomic committed replay drifted: %',v_replay;
  END IF;
  UPDATE public.salons SET archived_at=NULL,stripe_connect_charges_enabled=true WHERE id=v_salon;
  UPDATE public.services SET price_cents=5000 WHERE id=v_service;

  -- An expired initial provider attempt becomes reconciliation-only and keeps
  -- the exact stored routing material; it can never create a second intent.
  v_start:=v_start+interval '2 hours'; v_end:=v_start+interval '40 minutes';
  v_intent:='15150000-0000-4000-8000-000000000812';
  v_request:='15150000-0000-4000-8000-000000000811';
  v_quote:=public.quote_public_booking(v_salon,v_service,v_staff,v_start,v_end,
    ARRAY[]::uuid[],NULL,NULL,'+16045551811',NULL,false);
  v_claim:=public.claim_public_deposit_payment_operation(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    '+16045551811',NULL,false,v_intent,v_quote->>'pricing_fingerprint',v_request
  );
  v_operation:=(v_claim->>'operation_id')::uuid;
  v_provider_material:=v_claim->'provider_material';
  UPDATE public.booking_payment_operations SET lease_expires_at=now()-interval '1 second'
    WHERE id=v_operation;
  v_replay:=public.claim_public_deposit_payment_operation(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    '+16045551811',NULL,false,v_intent,v_quote->>'pricing_fingerprint',v_request
  );
  IF v_replay->>'code'<>'reconciliation_required' OR v_replay->>'status'<>'unknown'
     OR v_replay->'provider_material' IS DISTINCT FROM v_provider_material THEN
    RAISE EXCEPTION 'expired attach-loss was not fail-closed: %',v_replay;
  END IF;
  SELECT x INTO v_due FROM public.discover_due_booking_payment_reconciliations(1) x;
  IF v_due->>'operation_id'<>v_operation::text
     OR v_due->'provider_material' IS DISTINCT FROM v_provider_material
     OR v_due->>'attempt_count'<>'2' THEN
    RAISE EXCEPTION 'due reconciliation lease mismatch: %',v_due;
  END IF;

  -- Deliberately corrupt the authoritative binding phone after a simulated
  -- provider success.  The bind fails after canonical create, and the wrapper's
  -- subtransaction must remove every booking/profile write.
  v_start:=v_start+interval '2 hours'; v_end:=v_start+interval '40 minutes';
  v_intent:='15150000-0000-4000-8000-000000000822';
  v_request:='15150000-0000-4000-8000-000000000821';
  v_phone:='+16045551821';
  v_quote:=public.quote_public_booking(v_salon,v_service,v_staff,v_start,v_end,
    ARRAY[]::uuid[],NULL,NULL,v_phone,NULL,false);
  v_claim:=public.claim_public_deposit_payment_operation(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    v_phone,NULL,false,v_intent,v_quote->>'pricing_fingerprint',v_request
  );
  v_operation:=(v_claim->>'operation_id')::uuid; v_fp:=v_claim->>'material_fingerprint';
  v_complete:=public.complete_booking_payment_operation(
    v_operation,(v_claim->>'attempt_token')::uuid,'succeeded','succeeded',
    'pi_public_deposit_atomic_rollback',NULL,NULL
  );
  UPDATE public.booking_payment_operations SET client_phone_fingerprint=repeat('f',64)
    WHERE id=v_operation;
  v_create:=public.create_public_booking_with_deposit_payment(
    v_salon,v_service,v_staff,'Rollback QA',v_phone,v_start,v_end,'confirmed',NULL,
    ARRAY[]::uuid[],NULL,NULL,NULL,NULL,false,v_intent,v_quote->>'pricing_fingerprint',
    v_operation,v_request,v_fp
  );
  IF v_create->>'code'<>'atomic_deposit_bind_failed'
     OR EXISTS(SELECT 1 FROM public.bookings WHERE salon_id=v_salon AND idempotency_key=v_intent)
     OR EXISTS(SELECT 1 FROM public.client_profiles WHERE phone='16045551821') THEN
    RAISE EXCEPTION 'failed atomic bind leaked business writes: %',v_create;
  END IF;
END
$public_deposit_atomic$;

DO $desk_square_contracts$
DECLARE
  v_salon uuid := '15150000-0000-4000-8000-000000000001';
  v_service uuid := '15150000-0000-4000-8000-000000000002';
  v_staff uuid := '15150000-0000-4000-8000-000000000003';
  v_booking uuid;
  v_parent uuid;
  v_request uuid;
  v_operation uuid;
  v_start timestamptz := date_trunc('day',now())+interval '21 days 12 hours';
  v_end timestamptz;
  v_quote jsonb;
  v_claim jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_loaded jsonb;
  v_capability jsonb;
  v_first_claim jsonb;
  v_second_claim jsonb;
  v_attempt uuid;
  v_fp text;
  v_account_fp text := repeat('9',64);
  v_count integer;
BEGIN
  -- A caller-held saga request reserves the refund before cancellation.  The
  -- exact replay is available after the status guard would otherwise reject,
  -- and pending/ambiguous provider truth is durably projected on the saga.
  v_booking:='15150000-0000-4000-8000-000000000901';
  v_parent:='15150000-0000-4000-8000-000000000902';
  v_request:='15150000-0000-4000-8000-000000000903';
  v_end:=v_start+interval '30 minutes';
  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,
    status,deposit_required,deposit_amount_cents,deposit_status,deposit_paid_at,
    stripe_payment_intent_id,deposit_payment_ledger_enforced_at
  ) VALUES (
    v_booking,v_salon,v_service,v_staff,'Desk saga pending','+16045551901',v_start,v_end,
    'confirmed',true,1000,'paid',now(),'pi_desk_saga_pending',now()
  );
  INSERT INTO public.booking_payment_operations(
    id,salon_id,booking_id,request_id,operation_kind,provider,
    provider_account_fingerprint,amount_cents,currency,material_fingerprint,
    material_json,provider_material,provider_payment_id,provider_idempotency_key,
    status,result_json,completed_at
  ) VALUES (
    v_parent,v_salon,v_booking,gen_random_uuid(),'deposit_charge','stripe',v_account_fp,
    1000,'CAD',repeat('1',64),jsonb_build_object('amount_cents',1000),
    jsonb_build_object('provider','stripe','provider_account_id','acct_desk_saga'),
    'pi_desk_saga_pending','nq:'||v_parent::text,'succeeded','{}',now()
  );
  INSERT INTO public.booking_waitlist_entries(
    salon_id,service_id,booking_date,client_name,client_phone,source,status
  ) VALUES (
    v_salon,v_service,(v_start AT TIME ZONE 'UTC')::date,
    'Desk saga waiter','+16045551909','booking_conflict','waiting'
  );
  v_claim:=public.cancel_booking_with_deposit_refund_saga(
    v_salon,v_booking,v_request,400,false,NULL
  );
  IF v_claim->>'code'<>'cancelled_refund_claimed'
     OR (SELECT status FROM public.bookings WHERE id=v_booking)<>'cancelled'
     OR v_claim->'cancellation_result'->'promoted_waitlist' IS NULL THEN
    RAISE EXCEPTION 'desk cancellation/refund saga claim failed: %',v_claim;
  END IF;
  v_replay:=public.cancel_booking_with_deposit_refund_saga(
    v_salon,v_booking,v_request,400,false,NULL
  );
  IF v_replay->>'code'<>'saga_replay'
     OR v_replay->>'refund_operation_id' IS DISTINCT FROM v_claim->>'refund_operation_id'
     OR v_replay->>'attempt_token' IS DISTINCT FROM v_claim->>'attempt_token' THEN
    RAISE EXCEPTION 'desk saga replay after cancellation failed: %',v_replay;
  END IF;
  v_operation:=(v_claim->>'refund_operation_id')::uuid;
  v_result:=public.complete_booking_payment_operation(
    v_operation,(v_claim->>'attempt_token')::uuid,'pending_provider','pending',NULL,
    're_desk_saga_pending',NULL
  );
  v_replay:=public.inspect_booking_cancel_deposit_refund_saga(v_salon,v_booking,v_request);
  IF v_result->>'code'<>'pending_provider' OR v_replay->>'saga_status'<>'refund_pending' THEN
    RAISE EXCEPTION 'desk saga pending truth not persisted: %, %',v_result,v_replay;
  END IF;
  UPDATE public.booking_payment_operations SET next_reconcile_at=now()-interval '1 second'
    WHERE id=v_operation;
  v_result:=public.claim_booking_payment_operation_reconciliation(
    v_operation,v_request,v_claim->>'refund_material_fingerprint'
  );
  v_result:=public.complete_booking_payment_operation(
    v_operation,(v_result->>'attempt_token')::uuid,'unknown','timeout',NULL,
    're_desk_saga_pending','provider_response_lost'
  );
  v_replay:=public.inspect_booking_cancel_deposit_refund_saga(v_salon,v_booking,v_request);
  IF v_result->>'code'<>'provider_outcome_unknown'
     OR v_replay->>'saga_status'<>'refund_unknown' THEN
    RAISE EXCEPTION 'desk saga ambiguous truth not persisted: %, %',v_result,v_replay;
  END IF;

  -- Staff-action wrapper binds the refund saga and customer notification to the
  -- same request before cancellation. It suppresses the legacy transition
  -- identity and preserves exact replay while provider truth is pending/unknown.
  v_start:=v_start+interval '2 hours'; v_end:=v_start+interval '30 minutes';
  v_booking:='15150000-0000-4000-8000-000000000971';
  v_parent:='15150000-0000-4000-8000-000000000972';
  v_request:='15150000-0000-4000-8000-000000000973';
  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
    start_time_utc,end_time_utc,status,deposit_required,deposit_amount_cents,
    deposit_status,deposit_paid_at,stripe_payment_intent_id,
    deposit_payment_ledger_enforced_at
  ) VALUES (
    v_booking,v_salon,v_service,v_staff,'Desk saga notification','+16045551921',
    'saga-notify@example.test',v_start,v_end,'confirmed',true,1000,'paid',now(),
    'pi_desk_saga_notification',now()
  );
  INSERT INTO public.booking_payment_operations(
    id,salon_id,booking_id,request_id,operation_kind,provider,
    provider_account_fingerprint,amount_cents,currency,material_fingerprint,
    material_json,provider_material,provider_payment_id,provider_idempotency_key,
    status,result_json,completed_at
  ) VALUES (
    v_parent,v_salon,v_booking,gen_random_uuid(),'deposit_charge','stripe',v_account_fp,
    1000,'CAD',repeat('3',64),jsonb_build_object('amount_cents',1000),
    jsonb_build_object('provider','stripe','provider_account_id','acct_desk_saga'),
    'pi_desk_saga_notification','nq:'||v_parent::text,'succeeded','{}',now()
  );
  v_claim:=public.cancel_booking_with_deposit_refund_saga_for_desk(
    v_salon,v_booking,v_request,500,true,true,
    '15150000-0000-4000-8000-000000000004',now()+interval '20 seconds'
  );
  IF v_claim->>'code'<>'cancelled_refund_claimed'
     OR v_claim->'staff_action_notification'->>'code'<>'loaded'
     OR EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox
       WHERE booking_id=v_booking AND event_type='cancel')
     OR (SELECT count(*) FROM public.staff_action_notification_outbox
       WHERE salon_id=v_salon AND request_id=v_request)<>1 THEN
    RAISE EXCEPTION 'refund cancellation/outbox was not atomic: %',v_claim;
  END IF;
  v_replay:=public.cancel_booking_with_deposit_refund_saga_for_desk(
    v_salon,v_booking,v_request,500,true,true,
    '15150000-0000-4000-8000-000000000004',now()+interval '20 seconds'
  );
  IF v_replay->>'code'<>'saga_replay'
     OR v_replay->>'refund_operation_id' IS DISTINCT FROM v_claim->>'refund_operation_id'
     OR v_replay->'staff_action_notification'->>'outbox_id'
       IS DISTINCT FROM v_claim->'staff_action_notification'->>'outbox_id' THEN
    RAISE EXCEPTION 'refund cancellation exact replay drifted: %',v_replay;
  END IF;
  v_replay:=public.cancel_booking_with_deposit_refund_saga_for_desk(
    v_salon,v_booking,v_request,500,true,false,
    '15150000-0000-4000-8000-000000000004',now()+interval '20 seconds'
  );
  IF v_replay->>'code'<>'idempotency_mismatch' THEN
    RAISE EXCEPTION 'refund cancellation changed channels accepted: %',v_replay;
  END IF;
  v_replay:=public.cancel_booking_with_deposit_refund_saga_for_desk(
    v_salon,v_booking,v_request,500,true,true,
    '15150000-0000-4000-8000-000000000005',now()+interval '20 seconds'
  );
  IF v_replay->>'code'<>'idempotency_mismatch' THEN
    RAISE EXCEPTION 'refund cancellation changed actor accepted: %',v_replay;
  END IF;
  v_operation:=(v_claim->>'refund_operation_id')::uuid;
  v_result:=public.complete_booking_payment_operation(
    v_operation,(v_claim->>'attempt_token')::uuid,'pending_provider','pending',NULL,
    're_desk_saga_notification',NULL
  );
  v_replay:=public.cancel_booking_with_deposit_refund_saga_for_desk(
    v_salon,v_booking,v_request,500,true,true,
    '15150000-0000-4000-8000-000000000004',now()+interval '20 seconds'
  );
  IF v_result->>'code'<>'pending_provider' OR v_replay->>'saga_status'<>'refund_pending'
     OR v_replay->'staff_action_notification'->>'outbox_id'
       IS DISTINCT FROM v_claim->'staff_action_notification'->>'outbox_id' THEN
    RAISE EXCEPTION 'refund pending combined replay failed: %, %',v_result,v_replay;
  END IF;

  -- A second saga proves terminal success and the exact parent refund receipt.
  v_start:=v_start+interval '1 hour'; v_end:=v_start+interval '30 minutes';
  v_booking:='15150000-0000-4000-8000-000000000911';
  v_parent:='15150000-0000-4000-8000-000000000912';
  v_request:='15150000-0000-4000-8000-000000000913';
  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,
    status,deposit_required,deposit_amount_cents,deposit_status,deposit_paid_at,
    stripe_payment_intent_id,deposit_payment_ledger_enforced_at
  ) VALUES (
    v_booking,v_salon,v_service,v_staff,'Desk saga success','+16045551911',v_start,v_end,
    'confirmed',true,1000,'paid',now(),'pi_desk_saga_success',now()
  );
  INSERT INTO public.booking_payment_operations(
    id,salon_id,booking_id,request_id,operation_kind,provider,
    provider_account_fingerprint,amount_cents,currency,material_fingerprint,
    material_json,provider_material,provider_payment_id,provider_idempotency_key,
    status,result_json,completed_at
  ) VALUES (
    v_parent,v_salon,v_booking,gen_random_uuid(),'deposit_charge','stripe',v_account_fp,
    1000,'CAD',repeat('2',64),jsonb_build_object('amount_cents',1000),
    jsonb_build_object('provider','stripe','provider_account_id','acct_desk_saga'),
    'pi_desk_saga_success','nq:'||v_parent::text,'succeeded','{}',now()
  );
  v_claim:=public.cancel_booking_with_deposit_refund_saga(
    v_salon,v_booking,v_request,1000,false,NULL
  );
  v_result:=public.complete_booking_payment_operation(
    (v_claim->>'refund_operation_id')::uuid,(v_claim->>'attempt_token')::uuid,
    'succeeded','succeeded',NULL,'re_desk_saga_success',NULL
  );
  v_replay:=public.inspect_booking_cancel_deposit_refund_saga(v_salon,v_booking,v_request);
  IF v_result->>'code'<>'succeeded' OR v_replay->>'saga_status'<>'refunded'
     OR v_replay->>'provider_refund_id'<>'re_desk_saga_success' THEN
    RAISE EXCEPTION 'desk saga success truth not persisted: %, %',v_result,v_replay;
  END IF;

  -- Configure an exact Square account for both hosted-link and public
  -- customer-present paths.  The access token remains server-only material.
  UPDATE public.salons SET payment_provider='square',deposit_high_value_cents=1,
    deposit_pct_new_customer=20,stripe_connect_charges_enabled=false
    WHERE id=v_salon;
  INSERT INTO public.square_integrations(
    salon_id,merchant_id,location_id,access_token,enabled,deposit_enabled,
    deposit_percent,deposit_risk_threshold,application_id,environment
  ) VALUES (
    v_salon,'merchant_square_rehearsal','location_square_rehearsal','secret-square-token',
    true,true,20,0,'application_square_rehearsal','sandbox'
  ) ON CONFLICT(salon_id) DO UPDATE SET
    merchant_id=excluded.merchant_id,location_id=excluded.location_id,
    access_token=excluded.access_token,enabled=true,deposit_enabled=true,
    deposit_percent=20,application_id=excluded.application_id,environment='sandbox';
  UPDATE public.square_integrations SET environment='invalid' WHERE salon_id=v_salon;
  v_result:=public.booking_payment_provider_context(v_salon,'deposit_charge');
  IF v_result->>'code'<>'square_environment_invalid' THEN
    RAISE EXCEPTION 'invalid Square environment did not fail closed: %',v_result;
  END IF;
  UPDATE public.square_integrations SET environment='sandbox' WHERE salon_id=v_salon;

  -- Hosted link is claimed before the provider, persists exact link/order,
  -- reconciles to the one Square payment receipt, releases the hold, and is a
  -- recognized refundable parent.
  v_start:=v_start+interval '2 hours'; v_end:=v_start+interval '30 minutes';
  v_booking:='15150000-0000-4000-8000-000000000921';
  v_request:='15150000-0000-4000-8000-000000000923';
  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,
    status,price_cents
  ) VALUES (
    v_booking,v_salon,v_service,v_staff,'Hosted link QA','+16045551921',v_start,v_end,
    'confirmed',5000
  );
  v_claim:=public.claim_booking_square_deposit_link(v_salon,v_booking,v_request,true);
  IF v_claim->>'code'<>'link_claimed' OR length(v_claim->>'provider_idempotency_key')>45 THEN
    RAISE EXCEPTION 'Square hosted link claim failed: %',v_claim;
  END IF;
  v_operation:=(v_claim->>'operation_id')::uuid; v_fp:=v_claim->>'material_fingerprint';
  v_result:=public.attach_booking_square_deposit_link(
    v_operation,(v_claim->>'attempt_token')::uuid,'plink_hosted_qa','order_hosted_qa',
    'https://square.example.test/pay/hosted-qa'
  );
  v_replay:=public.claim_booking_square_deposit_link(v_salon,v_booking,v_request,true);
  IF v_result->>'code'<>'link_attached' OR v_replay->>'code'<>'link_ready'
     OR v_replay->>'provider_order_id'<>'order_hosted_qa'
     OR v_replay->>'link_url'<>'https://square.example.test/pay/hosted-qa' THEN
    RAISE EXCEPTION 'Square hosted link replay failed: %, %',v_result,v_replay;
  END IF;
  UPDATE public.booking_payment_operations SET next_reconcile_at=now()-interval '1 second'
    WHERE id=v_operation;
  v_result:=public.claim_booking_payment_operation_reconciliation(v_operation,v_request,v_fp);
  IF v_result->>'provider_order_id'<>'order_hosted_qa'
     OR v_result->>'delivery_mode'<>'square_hosted_link' THEN
    RAISE EXCEPTION 'hosted link reconciliation lost provider material: %',v_result;
  END IF;
  v_result:=public.complete_booking_payment_operation(
    v_operation,(v_result->>'attempt_token')::uuid,'succeeded','COMPLETED',
    'square_payment_hosted_qa',NULL,NULL
  );
  IF v_result->>'code'<>'succeeded'
     OR (SELECT deposit_status FROM public.bookings WHERE id=v_booking)<>'paid'
     OR (SELECT status FROM public.bookings WHERE id=v_booking)<>'confirmed'
     OR (SELECT deposit_hold FROM public.bookings WHERE id=v_booking) IS TRUE THEN
    RAISE EXCEPTION 'hosted link completion failed: %',v_result;
  END IF;
  v_loaded:=public.load_booking_payment_operation_material(
    v_salon,v_booking,'deposit_refund',100
  );
  IF v_loaded->>'code'<>'material_loaded'
     OR v_loaded->>'provider'<>'square'
     OR v_loaded->>'parent_payment_id'<>'square_payment_hosted_qa' THEN
    RAISE EXCEPTION 'hosted link was not a refundable parent: %',v_loaded;
  END IF;

  -- Public Square returns only a customer-present capability to the browser;
  -- the service claim recovers the one stable attempt/provider key.  A second
  -- claim is an exact provider-idempotency replay, never a MIT saved-card path.
  v_start:=date_trunc('day',now())+interval '25 days 12 hours';
  v_end:=v_start+interval '40 minutes';
  v_request:='15150000-0000-4000-8000-000000000931';
  v_booking:='15150000-0000-4000-8000-000000000932'; -- canonical intent id
  v_quote:=public.quote_public_booking(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    '+16045551931',NULL,false
  );
  v_claim:=public.claim_public_deposit_payment_operation(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    '+16045551931',NULL,false,v_booking,v_quote->>'pricing_fingerprint',v_request
  );
  IF v_claim->>'code'<>'claimed'
     OR v_claim->'provider_material' ? 'saved_card_id'
     OR v_claim->'provider_material' ? 'customer_id'
     OR (SELECT delivery_mode FROM public.booking_payment_operations
          WHERE id=(v_claim->>'operation_id')::uuid)<>'public_customer_present' THEN
    RAISE EXCEPTION 'public Square canonical claim failed: %',v_claim;
  END IF;
  v_operation:=(v_claim->>'operation_id')::uuid;
  v_capability:=public.issue_public_square_deposit_capability(
    v_operation,v_request,(v_claim->>'attempt_token')::uuid,
    'public-square-capability-payment-rehearsal-0001'
  );
  IF v_capability->>'code'<>'capability_issued'
     OR v_capability ? 'attempt_token' OR v_capability ? 'provider_idempotency_key'
     OR v_capability ? 'provider_material'
     OR v_capability->>'square_application_id'<>'application_square_rehearsal'
     OR v_capability->>'square_location_id'<>'location_square_rehearsal'
     OR v_capability->>'square_environment'<>'sandbox' THEN
    RAISE EXCEPTION 'public Square browser-safe capability failed: %',v_capability;
  END IF;
  v_result:=public.claim_public_square_deposit_completion(
    v_operation,v_request,'wrong-public-square-capability-token-0000'
  );
  IF v_result->>'code'<>'invalid_capability_token' THEN
    RAISE EXCEPTION 'wrong public Square capability accepted: %',v_result;
  END IF;
  v_first_claim:=public.claim_public_square_deposit_completion(
    v_operation,v_request,'public-square-capability-payment-rehearsal-0001'
  );
  v_second_claim:=public.claim_public_square_deposit_completion(
    v_operation,v_request,'public-square-capability-payment-rehearsal-0001'
  );
  IF v_first_claim->>'code'<>'square_payment_claimed'
     OR v_second_claim->>'code'<>'square_payment_attempt_replay'
     OR v_second_claim->>'attempt_token' IS DISTINCT FROM v_first_claim->>'attempt_token'
     OR v_second_claim->>'provider_idempotency_key' IS DISTINCT FROM v_first_claim->>'provider_idempotency_key'
     OR v_first_claim->'provider_material' ? 'saved_card_id'
     OR v_first_claim->'provider_material' ? 'customer_id' THEN
    RAISE EXCEPTION 'public Square attempt replay failed: %, %',v_first_claim,v_second_claim;
  END IF;
  v_result:=public.complete_booking_payment_operation(
    v_operation,(v_first_claim->>'attempt_token')::uuid,'succeeded','COMPLETED',
    'square_payment_public_customer_qa',NULL,NULL
  );
  IF v_result->>'code'<>'succeeded_unbound'
     OR v_result->'result'->>'provider_payment_id'<>'square_payment_public_customer_qa' THEN
    RAISE EXCEPTION 'public Square ledger completion failed: %',v_result;
  END IF;

  -- If the customer-present provider accepts but no response/receipt reaches
  -- NailIQ, the one-time source is deliberately not retained.  The operation
  -- becomes manual/unknown and no due lease can redispatch a second charge.
  v_start:=v_start+interval '2 hours'; v_end:=v_start+interval '40 minutes';
  v_request:='15150000-0000-4000-8000-000000000941';
  v_booking:='15150000-0000-4000-8000-000000000942';
  v_quote:=public.quote_public_booking(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    '+16045551941',NULL,false
  );
  v_claim:=public.claim_public_deposit_payment_operation(
    v_salon,v_service,v_staff,v_start,v_end,ARRAY[]::uuid[],NULL,NULL,
    '+16045551941',NULL,false,v_booking,v_quote->>'pricing_fingerprint',v_request
  );
  v_operation:=(v_claim->>'operation_id')::uuid;
  v_capability:=public.issue_public_square_deposit_capability(
    v_operation,v_request,(v_claim->>'attempt_token')::uuid,
    'public-square-capability-ambiguous-rehearsal-0001'
  );
  v_first_claim:=public.claim_public_square_deposit_completion(
    v_operation,v_request,'public-square-capability-ambiguous-rehearsal-0001'
  );
  v_result:=public.complete_booking_payment_operation(
    v_operation,(v_first_claim->>'attempt_token')::uuid,'unknown','timeout',NULL,NULL,
    'provider_response_lost'
  );
  v_replay:=public.claim_public_square_deposit_completion(
    v_operation,v_request,'public-square-capability-ambiguous-rehearsal-0001'
  );
  IF v_result->>'code'<>'provider_outcome_unknown'
     OR v_replay->>'code'<>'reconciliation_required'
     OR v_replay ? 'attempt_token' THEN
    RAISE EXCEPTION 'ambiguous public Square payment was redispatchable: %, %',v_result,v_replay;
  END IF;
  v_replay:=public.claim_booking_payment_operation_reconciliation(
    v_operation,v_request,v_claim->>'material_fingerprint'
  );
  IF v_replay->>'code'<>'manual_reconciliation_required'
     OR v_replay ? 'attempt_token' OR v_replay ? 'provider_idempotency_key' THEN
    RAISE EXCEPTION 'ambiguous public Square reconciliation was not manual-only: %',v_replay;
  END IF;
  UPDATE public.booking_payment_operations SET next_reconcile_at=now()-interval '1 second'
    WHERE id=v_operation;
  SELECT count(*) INTO v_count FROM public.discover_due_booking_payment_reconciliations(100) x
    WHERE x->>'operation_id'=v_operation::text;
  IF v_count<>0 OR (SELECT attempt_count FROM public.booking_payment_operations
      WHERE id=v_operation)<>1 THEN
    RAISE EXCEPTION 'ambiguous public Square operation was re-leased: %',v_count;
  END IF;
END
$desk_square_contracts$;

-- Service-only ACL and fixed search_path are executable release boundaries.
DO $acl$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname<>'sync_booking_cancel_deposit_refund_saga'
    AND (p.proname LIKE '%booking_payment%' OR p.proname LIKE '%public_deposit%'
         OR p.proname LIKE '%public_booking_create_request%'
         OR p.proname LIKE '%unbound_deposit%' OR p.proname LIKE '%late_cancel_refund%'
         OR p.proname LIKE '%deposit_refund_saga%' OR p.proname LIKE '%square_deposit%')
    AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
         OR has_function_privilege('anon',p.oid,'EXECUTE')
         OR has_function_privilege('authenticated',p.oid,'EXECUTE')
         OR NOT has_function_privilege('service_role',p.oid,'EXECUTE'));
  IF v_bad<>0 THEN RAISE EXCEPTION 'payment RPC ACL/search_path failures: %',v_bad; END IF;
END
$acl$;

ROLLBACK;
SELECT 'booking payment operation rehearsal passed' AS result;
