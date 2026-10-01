-- Synthetic local/disposable QA only. Caller MUST wrap fixtures in BEGIN/ROLLBACK.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
INSERT INTO public.platform_settings(id,twilio_account_sid,twilio_phone_number)
VALUES('platform','AC11111111111111111111111111111111','+16045550999')
ON CONFLICT(id) DO UPDATE SET twilio_account_sid=excluded.twilio_account_sid,twilio_phone_number=excluded.twilio_phone_number;
INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('e2e-signed-confirm','Synthetic','Synthetic');
INSERT INTO public.salons(id,slug,name,phone,timezone,is_beta) VALUES
('30261001-0000-4000-8000-000000000031','e2e-signed-confirm-a','Synthetic A','+16045550991','America/Vancouver',true),
('30261001-0000-4000-8000-000000000032','e2e-signed-confirm-b','Synthetic B','+16045550992','America/Vancouver',true);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category) VALUES
('30261001-0000-4000-8000-000000000041','30261001-0000-4000-8000-000000000031','Synthetic',2500,30,'e2e-signed-confirm'),
('30261001-0000-4000-8000-000000000042','30261001-0000-4000-8000-000000000032','Synthetic',2500,30,'e2e-signed-confirm');
INSERT INTO public.staff(id,salon_id,name,status) VALUES
('30261001-0000-4000-8000-000000000051','30261001-0000-4000-8000-000000000031','Synthetic A','active'),
('30261001-0000-4000-8000-000000000052','30261001-0000-4000-8000-000000000032','Synthetic B','active');
INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) VALUES
('30261001-0000-4000-8000-000000000061','30261001-0000-4000-8000-000000000031','30261001-0000-4000-8000-000000000041','30261001-0000-4000-8000-000000000051','Synthetic','+16045550101',now()+interval '10 days',now()+interval '10 days 30 minutes','pending',2500),
('30261001-0000-4000-8000-000000000062','30261001-0000-4000-8000-000000000031','30261001-0000-4000-8000-000000000041','30261001-0000-4000-8000-000000000051','Synthetic','+16045550101',now()+interval '11 days',now()+interval '11 days 30 minutes','pending',2500);
DO $tests$
DECLARE
 a text:='AC11111111111111111111111111111111'; sender text:='+16045550999'; h text:=repeat('a',64);
 first_id uuid:='30261001-0000-4000-8000-000000000061'; second_id uuid:='30261001-0000-4000-8000-000000000062';
 r jsonb; original jsonb; role_name text; existing_confirmation timestamptz;
BEGIN
 -- 1: confirmation, event, log and receipt commit together; preserve a prior timestamp.
 UPDATE public.bookings SET confirmed_at=now()-interval '1 minute' WHERE id=first_id;
 SELECT confirmed_at INTO existing_confirmation FROM public.bookings WHERE id=first_id;
 r:=public.confirm_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550101',sender,h);
 IF r->>'code' IS DISTINCT FROM 'applied' OR r->>'booking_id' IS DISTINCT FROM first_id::text
  OR (SELECT status FROM public.bookings WHERE id=first_id) IS DISTINCT FROM 'confirmed'
  OR (SELECT confirmed_at FROM public.bookings WHERE id=first_id) IS DISTINCT FROM existing_confirmation
  OR (SELECT count(*) FROM public.booking_events WHERE booking_id=first_id AND event_type='booking_confirmed')<>1
  OR (SELECT count(*) FROM public.booking_notifications WHERE twilio_message_sid='SM11111111111111111111111111111111')<>1
 THEN RAISE EXCEPTION 'confirm_case_1'; END IF;
 original:=r;
 -- 2: a replay after original completion does not confirm the next booking.
 UPDATE public.bookings SET status='completed' WHERE id=first_id;
 r:=public.confirm_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550101',sender,h);
 IF r IS DISTINCT FROM (original||jsonb_build_object('idempotent',true))
  OR (SELECT status FROM public.bookings WHERE id=second_id) IS DISTINCT FROM 'pending'
  OR (SELECT count(*) FROM public.booking_events WHERE booking_id=first_id AND event_type='booking_confirmed')<>1
  OR (SELECT count(*) FROM public.booking_notifications WHERE twilio_message_sid='SM11111111111111111111111111111111')<>1
 THEN RAISE EXCEPTION 'confirm_case_2_retarget_or_duplicate'; END IF;
 -- 3-6: same SID cannot change body, caller, destination or action.
 r:=public.confirm_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550101',sender,repeat('b',64));
 IF r->>'code' IS DISTINCT FROM 'idempotency_mismatch' THEN RAISE EXCEPTION 'confirm_case_3'; END IF;
 r:=public.confirm_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550102',sender,h);
 IF r->>'code' IS DISTINCT FROM 'idempotency_mismatch' THEN RAISE EXCEPTION 'confirm_case_4'; END IF;
 r:=public.confirm_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550101','+16045550998',h);
 IF r->>'code' IS DISTINCT FROM 'idempotency_mismatch' THEN RAISE EXCEPTION 'confirm_case_5'; END IF;
 r:=public.cancel_booking_from_signed_sms(a,'SM11111111111111111111111111111111','+16045550101',sender,h);
 IF r->>'code' IS DISTINCT FROM 'idempotency_mismatch' THEN RAISE EXCEPTION 'confirm_case_6'; END IF;
 -- 7-9: wrong sender/account or malformed SID cannot write receipts.
 r:=public.confirm_booking_from_signed_sms('AC22222222222222222222222222222222','SM22222222222222222222222222222222','+16045550101',sender,h);
 IF r->>'code' IS DISTINCT FROM 'sender_unverified' THEN RAISE EXCEPTION 'confirm_case_7'; END IF;
 r:=public.confirm_booking_from_signed_sms(a,'SM22222222222222222222222222222222','+16045550101','+16045550998',h);
 IF r->>'code' IS DISTINCT FROM 'sender_unverified' THEN RAISE EXCEPTION 'confirm_case_8'; END IF;
 r:=public.confirm_booking_from_signed_sms(a,'invalid','+16045550101',sender,h);
 IF r->>'code' IS DISTINCT FROM 'invalid_request' THEN RAISE EXCEPTION 'confirm_case_9'; END IF;
 -- 10: no-target receipt stays no-target after an appointment appears.
 r:=public.confirm_booking_from_signed_sms(a,'SM33333333333333333333333333333333','+16045550103',sender,h);
 IF r->>'code' IS DISTINCT FROM 'not_found' THEN RAISE EXCEPTION 'confirm_case_10'; END IF;
 INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents)
 SELECT '30261001-0000-4000-8000-000000000063',salon_id,service_id,staff_id,'Synthetic','+16045550103',now()+interval '12 days',now()+interval '12 days 30 minutes','pending',2500
 FROM public.bookings WHERE id=second_id;
 r:=public.confirm_booking_from_signed_sms(a,'SM33333333333333333333333333333333','+16045550103',sender,h);
 IF r->>'code' IS DISTINCT FROM 'not_found' OR r->>'idempotent' IS DISTINCT FROM 'true'
  OR (SELECT status FROM public.bookings WHERE id='30261001-0000-4000-8000-000000000063') IS DISTINCT FROM 'pending'
 THEN RAISE EXCEPTION 'confirm_case_10_retarget'; END IF;
 -- 11: ambiguity detection must not be limited to the first five appointments.
 INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents)
 SELECT '30261001-0000-4000-8000-000000000031','30261001-0000-4000-8000-000000000041','30261001-0000-4000-8000-000000000051','Synthetic','+16045550104',now()+make_interval(days=>20+g),now()+make_interval(days=>20+g,mins=>30),'pending',2500 FROM generate_series(1,6) g;
 INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents)
 VALUES('30261001-0000-4000-8000-000000000032','30261001-0000-4000-8000-000000000042','30261001-0000-4000-8000-000000000052','Synthetic','+16045550104',now()+interval '30 days',now()+interval '30 days 30 minutes','pending',2500);
 r:=public.confirm_booking_from_signed_sms(a,'SM44444444444444444444444444444444','+16045550104',sender,h);
 IF r->>'code' IS DISTINCT FROM 'ambiguous_salon' OR r?'salon_id'
  OR (SELECT count(*) FROM public.bookings WHERE client_phone=public.canonical_phone('+16045550104') AND status='pending')<>7
 THEN RAISE EXCEPTION 'confirm_case_11'; END IF;
 -- 12: removing the other salon's appointment does not reinterpret the SID.
 UPDATE public.bookings SET status='cancelled' WHERE client_phone=public.canonical_phone('+16045550104') AND salon_id='30261001-0000-4000-8000-000000000032';
 r:=public.confirm_booking_from_signed_sms(a,'SM44444444444444444444444444444444','+16045550104',sender,h);
 IF r->>'code' IS DISTINCT FROM 'ambiguous_salon' OR r->>'idempotent' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'confirm_case_12'; END IF;
 -- 13: a late unique log failure must roll back status, event and receipt.
 INSERT INTO public.booking_notifications(booking_id,salon_id,notification_type,channel,status,twilio_message_sid)
 VALUES(second_id,'30261001-0000-4000-8000-000000000031','inbound_confirm','sms','sent','SM55555555555555555555555555555555');
 BEGIN
  PERFORM public.confirm_booking_from_signed_sms(a,'SM55555555555555555555555555555555','+16045550101',sender,h);
  RAISE EXCEPTION 'confirm_case_13_missing_failure';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 IF (SELECT status FROM public.bookings WHERE id=second_id) IS DISTINCT FROM 'pending'
  OR EXISTS(SELECT 1 FROM public.sms_inbound_booking_receipts WHERE message_sid='SM55555555555555555555555555555555')
  OR EXISTS(SELECT 1 FROM public.booking_events WHERE booking_id=second_id AND event_type='booking_confirmed')
 THEN RAISE EXCEPTION 'confirm_case_13_partial_commit'; END IF;
 -- 14-15: already confirmed is stable and does not duplicate domain evidence.
 UPDATE public.bookings SET status='confirmed' WHERE id=second_id;
 r:=public.confirm_booking_from_signed_sms(a,'SM66666666666666666666666666666666','+16045550101',sender,h);
 IF r->>'code' IS DISTINCT FROM 'already_confirmed' OR r->>'booking_id' IS DISTINCT FROM second_id::text THEN RAISE EXCEPTION 'confirm_case_14'; END IF;
 IF EXISTS(SELECT 1 FROM public.booking_events WHERE booking_id=second_id AND event_type='booking_confirmed')
  OR EXISTS(SELECT 1 FROM public.booking_notifications WHERE twilio_message_sid='SM66666666666666666666666666666666')
 THEN RAISE EXCEPTION 'confirm_case_15_duplicate'; END IF;
 -- 16-17: browser roles cannot execute the function, including via real SET ROLE.
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_function_privilege(role_name,'public.confirm_booking_from_signed_sms(text,text,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'confirm_case_acl'; END IF;
  BEGIN
   EXECUTE format('SET LOCAL ROLE %I',role_name);
   PERFORM public.confirm_booking_from_signed_sms(a,'SM77777777777777777777777777777777','+16045550103',sender,h);
   RAISE EXCEPTION 'confirm_case_browser_allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'SET LOCAL ROLE postgres';
 END LOOP;
 -- 18: service role is permitted only through the checked RPC.
 IF NOT has_function_privilege('service_role','public.confirm_booking_from_signed_sms(text,text,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'confirm_case_18_acl'; END IF;
 EXECUTE 'SET LOCAL ROLE service_role';
 r:=public.confirm_booking_from_signed_sms(a,'SM77777777777777777777777777777777','+16045550106',sender,h);
 EXECUTE 'SET LOCAL ROLE postgres';
 IF r->>'code' IS DISTINCT FROM 'not_found' THEN RAISE EXCEPTION 'confirm_case_18'; END IF;
 -- 19: JWT role is a second backstop, even for a privileged direct caller.
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 r:=public.confirm_booking_from_signed_sms(a,'SM88888888888888888888888888888888','+16045550103',sender,h);
 IF r->>'code' IS DISTINCT FROM 'forbidden' THEN RAISE EXCEPTION 'confirm_case_19'; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 -- 20: a soft-deleted candidate cannot be selected.
 UPDATE public.bookings SET deleted_at=now() WHERE id=second_id;
 r:=public.confirm_booking_from_signed_sms(a,'SM99999999999999999999999999999999','+16045550101',sender,h);
 IF r->>'code' IS DISTINCT FROM 'not_found' THEN RAISE EXCEPTION 'confirm_case_20'; END IF;
 RAISE NOTICE 'inbound_confirm_atomic: 20 scenarios PASS; sequential PostgreSQL; providers OFF';
END;
$tests$;
