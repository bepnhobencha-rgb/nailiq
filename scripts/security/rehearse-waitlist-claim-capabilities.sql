\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('waitlist-cap-qa','Waitlist QA','Waitlist QA') ON CONFLICT DO NOTHING;
INSERT INTO public.salons(id,slug,name,phone,timezone,feature_flags)
VALUES('d7000000-0000-4000-8000-000000000001','waitlist-cap-qa','Waitlist QA','+16045550200','UTC','{}');
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('d7000000-0000-4000-8000-000000000002','d7000000-0000-4000-8000-000000000001',
  'Waitlist service',2500,30,'waitlist-cap-qa');
INSERT INTO public.staff(id,salon_id,name,status)
VALUES('d7000000-0000-4000-8000-000000000003','d7000000-0000-4000-8000-000000000001',
  'Waitlist staff','active');
INSERT INTO public.booking_waitlist_entries(id,salon_id,service_id,booking_date,client_name,
  client_phone,status,source,notified_at,claim_token)
VALUES('d7000000-0000-4000-8000-000000000010','d7000000-0000-4000-8000-000000000001',
  'd7000000-0000-4000-8000-000000000002',current_date+1,'Waitlist QA','+16045550201',
  'notified','slot_unavailable',transaction_timestamp(),'d7000000-0000-4000-8000-000000000011'),
('d7000000-0000-4000-8000-000000000012','d7000000-0000-4000-8000-000000000001',
  'd7000000-0000-4000-8000-000000000002',current_date+2,'Waitlist late worker','+16045550201',
  'notified','slot_unavailable',transaction_timestamp(),'d7000000-0000-4000-8000-000000000013');
INSERT INTO public.booking_waitlist_entries(id,salon_id,service_id,booking_date,client_name,
  client_phone,status,source,notified_at,claim_token,offered_staff_id,offered_start_utc,offered_end_utc)
VALUES('d7000000-0000-4000-8000-000000000014','d7000000-0000-4000-8000-000000000001',
  'd7000000-0000-4000-8000-000000000002',current_date+3,'Waitlist failed auto-book','+16045550201',
  'notified','slot_unavailable',transaction_timestamp(),'d7000000-0000-4000-8000-000000000015',
  'd7000000-0000-4000-8000-000000000003',transaction_timestamp()+interval '3 days',
  transaction_timestamp()+interval '3 days 30 minutes');
INSERT INTO public.booking_waitlist_entries(id,salon_id,service_id,booking_date,client_name,
  client_phone,status,source,notified_at,claim_token,created_at)
VALUES
('d7000000-0000-4000-8000-000000000018','d7000000-0000-4000-8000-000000000001',
 'd7000000-0000-4000-8000-000000000002',current_date+5,'Expired offer','+16045550201',
 'notified','slot_unavailable',transaction_timestamp()-interval '30 minutes',
 'd7000000-0000-4000-8000-000000000020',transaction_timestamp()-interval '40 minutes'),
('d7000000-0000-4000-8000-000000000019','d7000000-0000-4000-8000-000000000001',
 'd7000000-0000-4000-8000-000000000002',current_date+5,'Next FIFO','+16045550201',
 'waiting','slot_unavailable',NULL,NULL,transaction_timestamp()-interval '20 minutes'),
('d7000000-0000-4000-8000-000000000024','d7000000-0000-4000-8000-000000000001',
 'd7000000-0000-4000-8000-000000000002',current_date+3,'Freed booking FIFO','+16045550201',
 'waiting','slot_unavailable',NULL,NULL,transaction_timestamp()-interval '10 minutes'),
('d7000000-0000-4000-8000-000000000025','d7000000-0000-4000-8000-000000000001',
 'd7000000-0000-4000-8000-000000000002',current_date+6,'Cancel wrapper FIFO','+16045550201',
 'waiting','slot_unavailable',NULL,NULL,transaction_timestamp()-interval '9 minutes'),
('d7000000-0000-4000-8000-000000000026','d7000000-0000-4000-8000-000000000001',
 'd7000000-0000-4000-8000-000000000002',current_date+7,'No-show wrapper FIFO','+16045550201',
 'waiting','slot_unavailable',NULL,NULL,transaction_timestamp()-interval '8 minutes');
INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,start_time_utc,end_time_utc,
  status,price_cents)
VALUES('d7000000-0000-4000-8000-000000000016','d7000000-0000-4000-8000-000000000001',
  'd7000000-0000-4000-8000-000000000002','d7000000-0000-4000-8000-000000000003',
  'Occupied','2030-01-01 00:00:00+00','2030-01-01 00:30:00+00','confirmed',2500),
('d7000000-0000-4000-8000-000000000027','d7000000-0000-4000-8000-000000000001',
  'd7000000-0000-4000-8000-000000000002','d7000000-0000-4000-8000-000000000003',
  'Cancel wrapper',date_trunc('day',transaction_timestamp())+interval '6 days 12 hours',
  date_trunc('day',transaction_timestamp())+interval '6 days 12 hours 30 minutes','confirmed',2500),
('d7000000-0000-4000-8000-000000000028','d7000000-0000-4000-8000-000000000001',
  'd7000000-0000-4000-8000-000000000002','d7000000-0000-4000-8000-000000000003',
  'No-show wrapper',date_trunc('day',transaction_timestamp())+interval '7 days 12 hours',
  date_trunc('day',transaction_timestamp())+interval '7 days 12 hours 30 minutes','no_show',2500);
UPDATE public.bookings SET start_time_utc=transaction_timestamp()+interval '3 days',
  end_time_utc=transaction_timestamp()+interval '3 days 30 minutes'
WHERE id='d7000000-0000-4000-8000-000000000016';
UPDATE public.salons SET feature_flags='{"waitlist_auto_book":true}'::jsonb,
  opening_hours='{"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false},"sun":{"open":"00:00","close":"23:59","closed":false}}'::jsonb
WHERE id='d7000000-0000-4000-8000-000000000001';
DO $behavior$
DECLARE v_token uuid; v_result jsonb; v_replay jsonb; v_before bigint; v_i integer;
  v_delivery jsonb; v_phone_hash text:=encode(extensions.digest(
    pg_catalog.convert_to('+16045550201','UTF8'),'sha256'),'hex');
  v_material text; v_token2 uuid; v_token3 uuid; v_token4 uuid; v_token5 uuid; v_loaded jsonb;
BEGIN
  FOR v_i IN 1..20 LOOP
    v_result:=public.mint_waitlist_claim_capability(
      'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000010',
      transaction_timestamp()+interval '30 minutes');
    IF v_token IS NULL THEN v_token:=(v_result->>'token_id')::uuid;
    ELSIF v_token<>(v_result->>'token_id')::uuid THEN RAISE EXCEPTION 'waitlist mint not deterministic'; END IF;
  END LOOP;
  SELECT count(*) INTO v_before FROM public.waitlist_claim_action_receipts;
  v_result:=public.inspect_waitlist_claim_capability(v_token);
  IF v_result->>'code'<>'available' OR (SELECT count(*) FROM public.waitlist_claim_action_receipts)<>v_before
     OR v_result::text~'Waitlist QA|16045550201' THEN
    RAISE EXCEPTION 'waitlist inspect writes or leaks PII: %',v_result;
  END IF;
  IF (SELECT status FROM public.waitlist_offer_delivery_outbox
      WHERE waitlist_entry_id='d7000000-0000-4000-8000-000000000010' AND channel='sms')<>'pending'
     OR (SELECT status FROM public.waitlist_offer_delivery_outbox
      WHERE waitlist_entry_id='d7000000-0000-4000-8000-000000000010' AND channel='email')<>'suppressed' THEN
    RAISE EXCEPTION 'waitlist delivery outbox not initialized truthfully';
  END IF;
  v_loaded:=public.load_waitlist_offer_delivery_material(
    'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000010',
    1,'sms',v_token);
  v_material:=v_loaded->>'material_fingerprint';
  IF v_loaded->>'code'<>'material_loaded' OR v_loaded->'snapshot'->>'salon_name'<>'Waitlist QA'
     OR v_loaded->'snapshot'->>'service_name'<>'Waitlist service'
     OR v_loaded->'snapshot'->>'recipient'<>'+16045550201'
     OR v_loaded->'snapshot'->>'locale'<>'en'
     OR NOT (v_loaded->'snapshot' ? 'sms_outbound_enabled')
     OR NOT (v_loaded->'snapshot' ? 'email_outbound_enabled') THEN
    RAISE EXCEPTION 'authoritative delivery material mismatch: %',v_loaded;
  END IF;
  v_delivery:=public.claim_waitlist_offer_delivery(
    'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000010',
    1,'sms',v_token,v_phone_hash,v_material,repeat('a',64));
  IF v_delivery->>'code'<>'claimed' THEN RAISE EXCEPTION 'delivery claim failed: %',v_delivery; END IF;
  v_result:=public.complete_waitlist_offer_delivery((v_delivery->>'outbox_id')::uuid,
    (v_delivery->>'attempt_token')::uuid,'sent','',NULL);
  IF v_result->>'code'<>'invalid_completion' THEN RAISE EXCEPTION 'blank sent receipt accepted'; END IF;
  v_result:=public.complete_waitlist_offer_delivery((v_delivery->>'outbox_id')::uuid,
    (v_delivery->>'attempt_token')::uuid,'sent','SM-bad',NULL);
  IF v_result->>'code'<>'invalid_completion' THEN RAISE EXCEPTION 'malformed SMS receipt accepted'; END IF;
  v_result:=public.complete_waitlist_offer_delivery((v_delivery->>'outbox_id')::uuid,
    (v_delivery->>'attempt_token')::uuid,'sent','SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',NULL);
  v_replay:=public.complete_waitlist_offer_delivery((v_delivery->>'outbox_id')::uuid,
    (v_delivery->>'attempt_token')::uuid,'sent','SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',NULL);
  IF v_result->>'status'<>'sent' OR v_replay->>'code'<>'already_completed' THEN
    RAISE EXCEPTION 'truthful delivery completion/replay failed: % / %',v_result,v_replay;
  END IF;
  v_result:=public.claim_waitlist_with_management_capability(v_token,
    'd7000000-0000-4000-8000-000000000020');
  v_replay:=public.claim_waitlist_with_management_capability(v_token,
    'd7000000-0000-4000-8000-000000000020');
  IF v_result->>'outcome'<>'claimed' OR v_replay->>'idempotent'<>'true'
     OR (SELECT count(*) FROM public.waitlist_claim_action_receipts WHERE capability_id=v_token)<>1
     OR (SELECT status FROM public.booking_waitlist_entries
       WHERE id='d7000000-0000-4000-8000-000000000010')<>'claimed' THEN
    RAISE EXCEPTION 'waitlist exact replay failed: % / %',v_result,v_replay;
  END IF;
  IF public.claim_waitlist_with_management_capability(v_token,
    'd7000000-0000-4000-8000-000000000021')->>'code'<>'idempotency_mismatch' THEN
    RAISE EXCEPTION 'changed waitlist request accepted';
  END IF;
  v_token2:=(public.mint_waitlist_claim_capability(
    'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000012',
    transaction_timestamp()+interval '30 minutes')->>'token_id')::uuid;
  SELECT material_fingerprint INTO v_material FROM public.waitlist_offer_delivery_outbox
  WHERE waitlist_entry_id='d7000000-0000-4000-8000-000000000012' AND channel='sms';
  PERFORM public.claim_waitlist_with_management_capability(v_token2,
    'd7000000-0000-4000-8000-000000000022');
  v_result:=public.claim_waitlist_offer_delivery(
    'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000012',
    1,'sms',v_token2,v_phone_hash,v_material,repeat('c',64));
  IF v_result->>'code'<>'offer_unavailable' OR NOT EXISTS(
    SELECT 1 FROM public.waitlist_offer_delivery_outbox
    WHERE waitlist_entry_id='d7000000-0000-4000-8000-000000000012'
      AND channel='sms' AND status='suppressed' AND error_code='offer_unavailable') THEN
    RAISE EXCEPTION 'delayed worker could send after claim: %',v_result;
  END IF;

  v_token3:=(public.mint_waitlist_claim_capability(
    'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000014',
    transaction_timestamp()+interval '30 minutes')->>'token_id')::uuid;
  v_result:=public.claim_waitlist_with_management_capability(v_token3,
    'd7000000-0000-4000-8000-000000000023');
  v_replay:=public.claim_waitlist_with_management_capability(v_token3,
    'd7000000-0000-4000-8000-000000000023');
  IF v_result->>'outcome'<>'auto_book_failed' OR v_replay->>'idempotent'<>'true'
     OR (SELECT status FROM public.booking_waitlist_entries
       WHERE id='d7000000-0000-4000-8000-000000000014')<>'waiting'
     OR (SELECT epoch FROM public.waitlist_claim_action_state
       WHERE waitlist_entry_id='d7000000-0000-4000-8000-000000000014')<>2
     OR public.inspect_waitlist_claim_capability(v_token3)->>'code'<>'unavailable' THEN
    RAISE EXCEPTION 'failed auto-book did not retire offer epoch: % / %',v_result,v_replay;
  END IF;
  UPDATE public.booking_waitlist_entries SET status='notified',notified_at=transaction_timestamp(),
    claim_token='d7000000-0000-4000-8000-000000000017',
    offered_staff_id='d7000000-0000-4000-8000-000000000003',
    offered_start_utc=transaction_timestamp()+interval '4 days',
    offered_end_utc=transaction_timestamp()+interval '4 days 30 minutes'
  WHERE id='d7000000-0000-4000-8000-000000000014';
  v_token4:=(public.mint_waitlist_claim_capability(
    'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000014',
    transaction_timestamp()+interval '30 minutes')->>'token_id')::uuid;
  IF v_token4=v_token3 OR NOT EXISTS(SELECT 1 FROM public.waitlist_offer_delivery_outbox
      WHERE waitlist_entry_id='d7000000-0000-4000-8000-000000000014'
        AND offer_epoch=2 AND channel='sms' AND status='pending') THEN
    RAISE EXCEPTION 're-offer reused old bearer/outbox epoch';
  END IF;
  v_loaded:=public.load_waitlist_offer_delivery_material(
    'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000014',
    2,'sms',v_token4);
  v_delivery:=public.claim_waitlist_offer_delivery(
    'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000014',
    2,'sms',v_token4,v_loaded->>'recipient_fingerprint',v_loaded->>'material_fingerprint',repeat('d',64));
  IF v_delivery->>'code'<>'claimed' THEN
    RAISE EXCEPTION 'new offer epoch delivery unavailable: %',v_delivery;
  END IF;

  v_token5:=(public.mint_waitlist_claim_capability(
    'd7000000-0000-4000-8000-000000000001','d7000000-0000-4000-8000-000000000018',
    transaction_timestamp()+interval '10 minutes')->>'token_id')::uuid;
  SELECT offer INTO v_result FROM public.advance_waitlist_offer_capabilities(20) offer LIMIT 1;
  IF v_result->>'waitlist_entry_id'<>'d7000000-0000-4000-8000-000000000019'
     OR v_result->>'salon_id'<>'d7000000-0000-4000-8000-000000000001'
     OR v_result->>'expired_waitlist_entry_id'<>'d7000000-0000-4000-8000-000000000018'
     OR (SELECT status FROM public.booking_waitlist_entries
       WHERE id='d7000000-0000-4000-8000-000000000018')<>'expired'
     OR public.inspect_waitlist_claim_capability(v_token5)->>'code'<>'unavailable' THEN
    RAISE EXCEPTION 'canonical advance did not return exact FIFO capability: %',v_result;
  END IF;
  UPDATE public.bookings SET status='cancelled'
  WHERE id='d7000000-0000-4000-8000-000000000016';
  v_result:=public.promote_waitlist_for_booking('d7000000-0000-4000-8000-000000000016');
  v_replay:=public.promote_waitlist_for_booking('d7000000-0000-4000-8000-000000000016');
  IF v_result->>'code'<>'promoted'
     OR v_result->>'waitlist_entry_id'<>'d7000000-0000-4000-8000-000000000024'
     OR v_result->>'claim_capability_token' IS NULL OR v_replay->>'idempotent'<>'true'
     OR v_replay->>'claim_capability_token'<>v_result->>'claim_capability_token'
     OR (SELECT count(*) FROM public.waitlist_offer_promotion_receipts
       WHERE source_booking_id='d7000000-0000-4000-8000-000000000016')<>1 THEN
    RAISE EXCEPTION 'booking-scoped exact FIFO promotion/replay failed: % / %',v_result,v_replay;
  END IF;
  v_result:=public.cancel_booking_by_id_with_waitlist_offer(
    'd7000000-0000-4000-8000-000000000027');
  v_replay:=public.cancel_booking_by_id_with_waitlist_offer(
    'd7000000-0000-4000-8000-000000000027');
  IF v_result->>'code'<>'ok'
     OR v_result->'promoted_waitlist'->>'waitlist_entry_id'<>'d7000000-0000-4000-8000-000000000025'
     OR v_replay->'promoted_waitlist'->>'claim_capability_token'
       <>v_result->'promoted_waitlist'->>'claim_capability_token'
     OR (SELECT count(*) FROM public.waitlist_offer_promotion_receipts
       WHERE source_booking_id='d7000000-0000-4000-8000-000000000027')<>1 THEN
    RAISE EXCEPTION 'canonical cancel wrapper did not replay exact offer: % / %',v_result,v_replay;
  END IF;
  PERFORM * FROM public.notify_waitlist_for_no_show(
    'd7000000-0000-4000-8000-000000000028');
  IF (SELECT status FROM public.booking_waitlist_entries
      WHERE id='d7000000-0000-4000-8000-000000000026')<>'notified'
     OR NOT EXISTS(SELECT 1 FROM public.waitlist_claim_capabilities
       WHERE waitlist_entry_id='d7000000-0000-4000-8000-000000000026'
         AND consumed_at IS NULL AND revoked_at IS NULL)
     OR NOT EXISTS(SELECT 1 FROM public.waitlist_offer_delivery_outbox
       WHERE waitlist_entry_id='d7000000-0000-4000-8000-000000000026' AND status='pending') THEN
    RAISE EXCEPTION 'legacy no-show compatibility did not use canonical offer';
  END IF;
END;
$behavior$;
ROLLBACK;
