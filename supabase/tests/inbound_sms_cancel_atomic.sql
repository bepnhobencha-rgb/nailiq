-- Run ONLY in a guarded loopback disposable transaction after the migration;
-- the harness must ROLLBACK both schema and fixtures. No provider calls.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
INSERT INTO public.platform_settings(id, twilio_account_sid, twilio_phone_number)
VALUES('platform', 'AC11111111111111111111111111111111', '+16045550999')
ON CONFLICT(id) DO UPDATE SET twilio_account_sid=excluded.twilio_account_sid,
  twilio_phone_number=excluded.twilio_phone_number;
INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('e2e-inbound-atomic-local','Synthetic','Synthetic');
INSERT INTO public.salons(id,slug,name,phone,timezone,is_beta) VALUES
('30260930-0000-4000-8000-000000000031','e2e-inbound-atomic-a','E2E synthetic A','+16045550991','America/Vancouver',true),
('30260930-0000-4000-8000-000000000032','e2e-inbound-atomic-b','E2E synthetic B','+16045550992','America/Vancouver',true);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category) VALUES
('30260930-0000-4000-8000-000000000041','30260930-0000-4000-8000-000000000031','Synthetic',2500,30,'e2e-inbound-atomic-local'),
('30260930-0000-4000-8000-000000000042','30260930-0000-4000-8000-000000000032','Synthetic',2500,30,'e2e-inbound-atomic-local');
INSERT INTO public.staff(id,salon_id,name,status) VALUES
('30260930-0000-4000-8000-000000000051','30260930-0000-4000-8000-000000000031','Synthetic A','active'),
('30260930-0000-4000-8000-000000000052','30260930-0000-4000-8000-000000000032','Synthetic B','active');
INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) VALUES
('30260930-0000-4000-8000-000000000061','30260930-0000-4000-8000-000000000031','30260930-0000-4000-8000-000000000041','30260930-0000-4000-8000-000000000051','Synthetic','+16045550101',now()+interval '10 days',now()+interval '10 days 30 minutes','confirmed',2500),
('30260930-0000-4000-8000-000000000062','30260930-0000-4000-8000-000000000031','30260930-0000-4000-8000-000000000041','30260930-0000-4000-8000-000000000051','Synthetic','+16045550101',now()+interval '11 days',now()+interval '11 days 30 minutes','confirmed',2500);

DO $tests$
DECLARE
  a text := 'AC11111111111111111111111111111111';
  sender text := '+16045550999'; h text := repeat('a',64);
  r jsonb; first_result jsonb; first_created timestamptz; role_name text;
  first_booking uuid := '30260930-0000-4000-8000-000000000061';
  second_booking uuid := '30260930-0000-4000-8000-000000000062';
BEGIN
  -- 1: cancellation and authoritative receipt commit together.
  r := public.cancel_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550101',sender,h);
  IF r->>'code' IS DISTINCT FROM 'applied' OR r->>'booking_id' IS DISTINCT FROM first_booking::text THEN RAISE EXCEPTION 'case_1'; END IF;
  IF (SELECT status FROM public.bookings WHERE id=first_booking) IS DISTINCT FROM 'cancelled' THEN RAISE EXCEPTION 'case_1_status'; END IF;
  first_result := r;
  SELECT created_at INTO first_created FROM public.sms_inbound_booking_receipts WHERE message_sid='SM11111111111111111111111111111111';
  -- 2: a replay must never select the next customer's appointment.
  r := public.cancel_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550101',sender,h);
  IF r IS DISTINCT FROM (first_result || jsonb_build_object('idempotent',true)) THEN RAISE EXCEPTION 'case_2'; END IF;
  IF (SELECT status FROM public.bookings WHERE id=second_booking) IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'case_2_retarget'; END IF;
  IF first_created IS NULL OR (SELECT created_at FROM public.sms_inbound_booking_receipts WHERE message_sid='SM11111111111111111111111111111111') IS DISTINCT FROM first_created THEN RAISE EXCEPTION 'case_2_rewrite'; END IF;
  IF (SELECT count(*) FROM public.booking_events WHERE booking_id=first_booking AND event_type='booking_cancelled') <> 1
    OR (SELECT count(*) FROM public.booking_notifications WHERE twilio_message_sid='SM11111111111111111111111111111111') <> 1 THEN RAISE EXCEPTION 'case_2_duplicate'; END IF;
  -- 3-5: same SID with a different body, from or destination is rejected.
  r := public.cancel_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550101',sender,repeat('b',64));
  IF r->>'code' IS DISTINCT FROM 'idempotency_mismatch' THEN RAISE EXCEPTION 'case_3'; END IF;
  r := public.cancel_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550102',sender,h);
  IF r->>'code' IS DISTINCT FROM 'idempotency_mismatch' THEN RAISE EXCEPTION 'case_4'; END IF;
  r := public.cancel_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550101','+16045550998',h);
  IF r->>'code' IS DISTINCT FROM 'idempotency_mismatch' THEN RAISE EXCEPTION 'case_5'; END IF;
  -- 6-7: wrong account/destination cannot consume or mutate a command.
  r := public.cancel_booking_from_signed_sms('AC22222222222222222222222222222222','SM22222222222222222222222222222222','+16045550101',sender,h);
  IF r->>'code' IS DISTINCT FROM 'sender_unverified' THEN RAISE EXCEPTION 'case_6'; END IF;
  r := public.cancel_booking_from_signed_sms(a,'SM22222222222222222222222222222222','+16045550101','+16045550998',h);
  IF r->>'code' IS DISTINCT FROM 'sender_unverified' THEN RAISE EXCEPTION 'case_7'; END IF;
  -- 8: malformed inputs create no receipt.
  r := public.cancel_booking_from_signed_sms(a,'not-a-sid','+16045550101',sender,h);
  IF r->>'code' IS DISTINCT FROM 'invalid_request' THEN RAISE EXCEPTION 'case_8'; END IF;
  -- 9: no match is durable, even if a booking subsequently appears.
  r := public.cancel_booking_from_signed_sms(a,'SM33333333333333333333333333333333','+16045550103',sender,h);
  IF r->>'code' IS DISTINCT FROM 'not_found' THEN RAISE EXCEPTION 'case_9'; END IF;
  INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents)
  SELECT '30260930-0000-4000-8000-000000000063',salon_id,service_id,staff_id,'Synthetic','+16045550103',now()+interval '12 days',now()+interval '12 days 30 minutes','confirmed',2500
  FROM public.bookings WHERE id=second_booking;
  r := public.cancel_booking_from_signed_sms(a,'SM33333333333333333333333333333333','+16045550103',sender,h);
  IF r->>'code' IS DISTINCT FROM 'not_found' OR r->>'idempotent' IS DISTINCT FROM 'true'
    OR (SELECT status FROM public.bookings WHERE id='30260930-0000-4000-8000-000000000063') IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'case_9_retarget'; END IF;
  -- 10: detect a second salon beyond the legacy first-five candidate window.
  INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents)
  SELECT '30260930-0000-4000-8000-000000000031','30260930-0000-4000-8000-000000000041','30260930-0000-4000-8000-000000000051','Synthetic','+16045550104',now()+make_interval(days=>20+g),now()+make_interval(days=>20+g,mins=>30),'confirmed',2500 FROM generate_series(1,6) g;
  INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents)
  VALUES('30260930-0000-4000-8000-000000000032','30260930-0000-4000-8000-000000000042','30260930-0000-4000-8000-000000000052','Synthetic','+16045550104',now()+interval '30 days',now()+interval '30 days 30 minutes','confirmed',2500);
  r := public.cancel_booking_from_signed_sms(a,'SM44444444444444444444444444444444','+16045550104',sender,h);
  IF r->>'code' IS DISTINCT FROM 'ambiguous_salon' OR r ? 'salon_id'
    OR (SELECT count(*) FROM public.bookings WHERE client_phone=public.canonical_phone('+16045550104') AND status='confirmed') <> 7 THEN RAISE EXCEPTION 'case_10'; END IF;
  -- 11: an ambiguous receipt stays ambiguous after staff remove the other salon's booking.
  UPDATE public.bookings SET status='cancelled' WHERE client_phone=public.canonical_phone('+16045550104') AND salon_id='30260930-0000-4000-8000-000000000032';
  r := public.cancel_booking_from_signed_sms(a,'SM44444444444444444444444444444444','+16045550104',sender,h);
  IF r->>'code' IS DISTINCT FROM 'ambiguous_salon' OR r->>'idempotent' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'case_11'; END IF;
  -- 12: actual DB exception after a domain write rolls it back with the receipt.
  BEGIN
    EXECUTE $mock$CREATE OR REPLACE FUNCTION public.cancel_booking_with_verified_sms_waitlist(p_booking_id uuid)
      RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO '' AS $body$
      BEGIN UPDATE public.bookings SET status='cancelled' WHERE id=p_booking_id;
        RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Synthetic post-write failure'; END;
      $body$$mock$;
    PERFORM public.cancel_booking_from_signed_sms(a,'SM55555555555555555555555555555555','+16045550101',sender,h);
    RAISE EXCEPTION 'case_12_missing_failure';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  IF (SELECT status FROM public.bookings WHERE id=second_booking) IS DISTINCT FROM 'confirmed'
    OR EXISTS(SELECT 1 FROM public.sms_inbound_booking_receipts WHERE message_sid='SM55555555555555555555555555555555') THEN RAISE EXCEPTION 'case_12_rollback'; END IF;
  -- 13: retry after that rollback can atomically apply once.
  r := public.cancel_booking_from_signed_sms(a,'SM55555555555555555555555555555555','+16045550101',sender,h);
  IF r->>'code' IS DISTINCT FROM 'applied' OR r->>'booking_id' IS DISTINCT FROM second_booking::text THEN RAISE EXCEPTION 'case_13'; END IF;
  -- 14: privilege/security metadata and actual unauthorized role backstop.
  IF EXISTS(SELECT 1 FROM (VALUES('anon'),('authenticated'),('service_role')) roles(role)
    WHERE has_table_privilege(role,'public.sms_inbound_booking_receipts','SELECT')
      OR has_table_privilege(role,'public.sms_inbound_booking_receipts','INSERT')
      OR has_table_privilege(role,'public.sms_inbound_booking_receipts','UPDATE')
      OR has_table_privilege(role,'public.sms_inbound_booking_receipts','DELETE')) THEN RAISE EXCEPTION 'case_14_table_acl'; END IF;
  IF has_function_privilege('anon','public.cancel_booking_from_signed_sms(text,text,text,text,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.cancel_booking_from_signed_sms(text,text,text,text,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.cancel_booking_from_signed_sms(text,text,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'case_14_rpc_acl'; END IF;
  IF EXISTS (SELECT 1 FROM (VALUES('anon'),('authenticated'),('service_role')) roles(role)
    WHERE has_function_privilege(role,'public.cancel_booking_with_verified_sms_waitlist(uuid)','EXECUTE'))
    OR (SELECT prosecdef FROM pg_proc WHERE oid='public.cancel_booking_with_verified_sms_waitlist(uuid)'::regprocedure)
    THEN RAISE EXCEPTION 'case_14_internal_helper_acl'; END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.sms_inbound_booking_receipts'::regclass) THEN RAISE EXCEPTION 'case_14_rls'; END IF;
  PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
  r := public.cancel_booking_from_signed_sms(a,'SM66666666666666666666666666666666','+16045550103',sender,h);
  IF r->>'code' IS DISTINCT FROM 'forbidden' THEN RAISE EXCEPTION 'case_14_jwt'; END IF;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  -- 15-16: original receipt cannot be updated or deleted.
  BEGIN UPDATE public.sms_inbound_booking_receipts SET result_json='{}' WHERE message_sid='SM11111111111111111111111111111111';
    RAISE EXCEPTION 'case_15_mutable'; EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN DELETE FROM public.sms_inbound_booking_receipts WHERE message_sid='SM11111111111111111111111111111111';
    RAISE EXCEPTION 'case_16_deletable'; EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  -- 17: an error in the final legacy log insert must roll back cancellation,
  -- event and authoritative receipt, not report partial success.
  INSERT INTO public.booking_notifications(booking_id,salon_id,notification_type,channel,status,twilio_message_sid)
  VALUES('30260930-0000-4000-8000-000000000063','30260930-0000-4000-8000-000000000031',
    'inbound_cancel','sms','sent','SM77777777777777777777777777777777');
  BEGIN
    PERFORM public.cancel_booking_from_signed_sms(a,'SM77777777777777777777777777777777','+16045550103',sender,h);
    RAISE EXCEPTION 'case_17_expected_log_conflict';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF (SELECT status FROM public.bookings WHERE id='30260930-0000-4000-8000-000000000063') IS DISTINCT FROM 'confirmed'
    OR EXISTS(SELECT 1 FROM public.sms_inbound_booking_receipts WHERE message_sid='SM77777777777777777777777777777777')
    OR EXISTS(SELECT 1 FROM public.booking_events WHERE booking_id='30260930-0000-4000-8000-000000000063' AND event_type='booking_cancelled') THEN
    RAISE EXCEPTION 'case_17_partial_commit';
  END IF;
  -- 18-21: actual PostgreSQL browser roles, not only has_* metadata.
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I',role_name);
      PERFORM 1 FROM public.sms_inbound_booking_receipts;
      RAISE EXCEPTION 'case_browser_read_allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    EXECUTE 'SET LOCAL ROLE postgres';
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I',role_name);
      PERFORM public.cancel_booking_from_signed_sms(a,'SM88888888888888888888888888888888','+16045550105',sender,h);
      RAISE EXCEPTION 'case_browser_rpc_allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    EXECUTE 'SET LOCAL ROLE postgres';
  END LOOP;
  -- 22-23: service role can only use the checked RPC, not read the private ledger.
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM 1 FROM public.sms_inbound_booking_receipts;
    RAISE EXCEPTION 'case_service_direct_read_allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  EXECUTE 'SET LOCAL ROLE postgres';
  EXECUTE 'SET LOCAL ROLE service_role';
  r := public.cancel_booking_from_signed_sms(a,'SM88888888888888888888888888888888','+16045550105',sender,h);
  EXECUTE 'SET LOCAL ROLE postgres';
  IF r->>'code' IS DISTINCT FROM 'not_found' THEN RAISE EXCEPTION 'case_service_rpc_denied'; END IF;
  RAISE NOTICE 'inbound_cancel_atomic: 23 scenarios PASS; sequential PostgreSQL only; no provider';
END;
$tests$;
