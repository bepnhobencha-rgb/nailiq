\set ON_ERROR_STOP on

BEGIN;
SET LOCAL request.jwt.claim.role='service_role';
INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('management-cap-qa','Management QA','Management QA') ON CONFLICT DO NOTHING;
INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,feature_flags,opening_hours,
  self_cancel_fee_enabled,self_cancel_window_hours,self_cancel_fee_percent,noshow_fee_percent)
VALUES('d6000000-0000-4000-8000-000000000001','management-cap-qa','Management QA',
  '+16045550100','America/Vancouver','CAD','{"waitlist_auto_book":true}'::jsonb,
  '{"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false},"sun":{"open":"00:00","close":"23:59","closed":false}}'::jsonb,
  true,24,50,100);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('d6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000001',
  'Capability service',3000,30,'management-cap-qa');
INSERT INTO public.staff(id,salon_id,name,status)
VALUES('d6000000-0000-4000-8000-000000000003','d6000000-0000-4000-8000-000000000001',
  'Capability staff','active');
INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_email,
  start_time_utc,end_time_utc,status,price_cents,group_id,is_group_organizer,is_party_member)
VALUES
('d6000000-0000-4000-8000-000000000010','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Solo QA','qa@example.test',
 (date_trunc('day',transaction_timestamp() AT TIME ZONE 'America/Vancouver')+interval '3 days 12 hours') AT TIME ZONE 'America/Vancouver',
 (date_trunc('day',transaction_timestamp() AT TIME ZONE 'America/Vancouver')+interval '3 days 12 hours 30 minutes') AT TIME ZONE 'America/Vancouver',
 'pending',3000,NULL,false,false),
('d6000000-0000-4000-8000-000000000011','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Past QA','qa@example.test',transaction_timestamp()-interval '1 hour',transaction_timestamp()-interval '30 minutes','confirmed',3000,NULL,false,false),
('d6000000-0000-4000-8000-000000000012','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Fee QA','qa@example.test',transaction_timestamp()+interval '12 hours',transaction_timestamp()+interval '12 hours 30 minutes','confirmed',3000,NULL,false,false),
('d6000000-0000-4000-8000-000000000013','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Horizon QA','qa@example.test',transaction_timestamp()+interval '90 days',transaction_timestamp()+interval '90 days 30 minutes','confirmed',3000,NULL,false,false),
('d6000000-0000-4000-8000-000000000014','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Late cancel QA','qa@example.test',transaction_timestamp()+interval '10 minutes',transaction_timestamp()+interval '40 minutes','confirmed',3000,NULL,false,false),
('d6000000-0000-4000-8000-000000000015','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Near reschedule QA','qa@example.test',transaction_timestamp()+interval '45 minutes',transaction_timestamp()+interval '75 minutes','confirmed',3000,NULL,false,false),
('d6000000-0000-4000-8000-000000000016','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Public exchange QA','qa@example.test',transaction_timestamp()+interval '2 days',transaction_timestamp()+interval '2 days 30 minutes','confirmed',3000,NULL,false,false),
('d6000000-0000-4000-8000-000000000020','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Organizer QA','qa@example.test',transaction_timestamp()+interval '5 days',transaction_timestamp()+interval '5 days 30 minutes','confirmed',3000,
 'd6000000-0000-4000-8000-000000000099',true,true),
('d6000000-0000-4000-8000-000000000021','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Member QA','qa@example.test',transaction_timestamp()+interval '5 days 1 hour',transaction_timestamp()+interval '5 days 1 hour 30 minutes','confirmed',3000,
 'd6000000-0000-4000-8000-000000000099',false,true),
('d6000000-0000-4000-8000-000000000022','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Organizer RSVP QA','qa@example.test',transaction_timestamp()+interval '7 days',transaction_timestamp()+interval '7 days 30 minutes','confirmed',3000,
 'd6000000-0000-4000-8000-000000000098',true,true),
('d6000000-0000-4000-8000-000000000023','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002','d6000000-0000-4000-8000-000000000003',
 'Member RSVP QA','qa@example.test',transaction_timestamp()+interval '7 days 1 hour',transaction_timestamp()+interval '7 days 1 hour 30 minutes','confirmed',3000,
 'd6000000-0000-4000-8000-000000000098',false,true);
UPDATE public.bookings SET noshow_fee_cents=1000,noshow_card_id='card_qa',
  noshow_consent_at=transaction_timestamp(),noshow_card_last4='4242',noshow_card_brand='visa'
WHERE id='d6000000-0000-4000-8000-000000000012';
UPDATE public.bookings SET attendance_status='pending'
WHERE id IN('d6000000-0000-4000-8000-000000000020','d6000000-0000-4000-8000-000000000021',
  'd6000000-0000-4000-8000-000000000023');
UPDATE public.bookings SET idempotency_key='d6000000-0000-4000-8000-000000000096',
  public_booking_pricing_fingerprint=repeat('b',64),public_booking_pricing_snapshot='{}'::jsonb
WHERE id='d6000000-0000-4000-8000-000000000016';

INSERT INTO public.booking_waitlist_entries(id,salon_id,service_id,booking_date,client_name,
  client_phone,client_email,status,source,created_at)
VALUES
('d6000000-0000-4000-8000-000000000030','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002',
 (date_trunc('day',transaction_timestamp() AT TIME ZONE 'America/Vancouver')+interval '3 days')::date,
 'Reschedule waiter','+16045550130','waiter@example.test','waiting','slot_unavailable',transaction_timestamp()-interval '2 minutes'),
('d6000000-0000-4000-8000-000000000031','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002',
 ((transaction_timestamp()+interval '10 minutes') AT TIME ZONE 'America/Vancouver')::date,
 'Late waiter','+16045550131','late@example.test','waiting','slot_unavailable',transaction_timestamp()-interval '1 minute'),
('d6000000-0000-4000-8000-000000000032','d6000000-0000-4000-8000-000000000001',
 'd6000000-0000-4000-8000-000000000002',
 ((transaction_timestamp()+interval '45 minutes') AT TIME ZONE 'America/Vancouver')::date,
 'Near reschedule waiter','+16045550132','near@example.test','waiting','slot_unavailable',transaction_timestamp());

DO $behavior$
DECLARE v_confirm uuid; v_reschedule uuid; v_cancel uuid; v_past uuid; v_fee_cap uuid; v_short uuid;
  v_group uuid; v_result jsonb; v_replay jsonb; v_before bigint; v_after bigint;
  v_member_confirm uuid; v_member_cancel uuid; v_org_confirm uuid;
  v_card uuid; v_card_claim jsonb; v_card_save uuid; v_card_setup uuid; v_card_finalize uuid;
  v_card_exchange uuid;
  v_wait_token uuid; v_near_reschedule uuid;
  v_request uuid:='d6000000-0000-4000-8000-000000000080'; v_i integer;
BEGIN
  v_result:=public.exchange_public_booking_card_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000016',
    'd6000000-0000-4000-8000-000000000097',repeat('b',64));
  IF v_result->>'code'<>'create_binding_invalid' THEN
    RAISE EXCEPTION 'public exchange accepted wrong idempotency key: %',v_result;
  END IF;
  v_result:=public.exchange_public_booking_card_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000016',
    'd6000000-0000-4000-8000-000000000096',repeat('b',64));
  v_card_exchange:=(v_result->>'token_id')::uuid;
  v_replay:=public.exchange_public_booking_card_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000016',
    'd6000000-0000-4000-8000-000000000096',repeat('b',64));
  IF v_result->>'code'<>'exchanged' OR v_card_exchange IS NULL
     OR v_replay->>'token_id'<>v_result->>'token_id' THEN
    RAISE EXCEPTION 'public create binding exchange is not deterministic: % / %',v_result,v_replay;
  END IF;
  FOR v_i IN 1..20 LOOP
    v_result:=public.mint_booking_management_capability(
      'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000010',
      'confirm',transaction_timestamp()+interval '1 hour');
    IF v_confirm IS NULL THEN v_confirm:=(v_result->>'token_id')::uuid;
    ELSIF v_confirm<>(v_result->>'token_id')::uuid THEN RAISE EXCEPTION 'mint not deterministic'; END IF;
  END LOOP;
  v_reschedule:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000010',
    'reschedule',transaction_timestamp()+interval '1 hour')->>'token_id')::uuid;
  v_cancel:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000010',
    'cancel',transaction_timestamp()+interval '1 hour')->>'token_id')::uuid;
  SELECT count(*) INTO v_before FROM public.booking_management_action_receipts;
  v_result:=public.inspect_booking_management_capability(v_cancel,'cancel');
  SELECT count(*) INTO v_after FROM public.booking_management_action_receipts;
  IF v_result->>'code'<>'valid' OR v_result->'booking'->>'salon_timezone'<>'America/Vancouver'
     OR v_result->'context'->>'booking_id'<>'d6000000-0000-4000-8000-000000000010'
     OR v_result->'cancel_preview'->>'currency'<>'CAD' OR v_before<>v_after THEN
    RAISE EXCEPTION 'inspect material/read-only mismatch: %',v_result;
  END IF;
  v_fee_cap:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000012',
    'cancel',transaction_timestamp()+interval '1 hour')->>'token_id')::uuid;
  v_result:=public.inspect_booking_management_capability(v_fee_cap,'cancel');
  IF v_result->'cancel_preview'->>'fee_cents'<>'500'
     OR v_result->'cancel_preview'->>'will_charge'<>'true'
     OR v_result->'cancel_preview'->>'has_chargeable_card'<>'true' THEN
    RAISE EXCEPTION 'late-cancel preview parity failed: %',v_result;
  END IF;
  v_result:=public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000013',
    'status',transaction_timestamp()+interval '1 hour');
  v_short:=(v_result->>'token_id')::uuid;
  v_result:=public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000013',
    'status',transaction_timestamp()+interval '90 days 1 hour');
  IF v_result->>'code'<>'minted' OR (v_result->>'token_id')::uuid=v_short
     OR (SELECT revoked_at IS NULL FROM public.booking_management_capabilities WHERE id=v_short) THEN
    RAISE EXCEPTION '90-day horizon or short-to-long replacement failed: %',v_result;
  END IF;
  v_result:=public.confirm_booking_with_management_capability(v_confirm,v_request);
  v_replay:=public.confirm_booking_with_management_capability(v_confirm,v_request);
  IF v_result->>'code'<>'confirmed' OR v_replay->>'idempotent'<>'true'
     OR (SELECT count(*) FROM public.booking_management_action_receipts WHERE capability_id=v_confirm)<>1
     OR (public.inspect_booking_management_capability(v_reschedule,'reschedule')->>'code')<>'valid' THEN
    RAISE EXCEPTION 'confirm/replay/action independence failed: % / %',v_result,v_replay;
  END IF;
  IF public.confirm_booking_with_management_capability(v_confirm,
      'd6000000-0000-4000-8000-000000000081')->>'code'<>'idempotency_mismatch' THEN
    RAISE EXCEPTION 'changed confirm replay accepted';
  END IF;
  v_result:=public.reschedule_booking_with_management_capability(v_reschedule,
    'd6000000-0000-4000-8000-000000000082',transaction_timestamp()+interval '4 days',
    transaction_timestamp()+interval '4 days 30 minutes');
  v_replay:=public.reschedule_booking_with_management_capability(v_reschedule,
    'd6000000-0000-4000-8000-000000000082',transaction_timestamp()+interval '4 days',
    transaction_timestamp()+interval '4 days 30 minutes');
  IF v_result->>'code'<>'rescheduled' OR v_replay->>'idempotent'<>'true'
     OR v_result->'cancel_preview' IS NULL
     OR v_result->'promoted_waitlist'->>'waitlist_entry_id'<>'d6000000-0000-4000-8000-000000000030'
     OR (SELECT count(*) FROM public.customer_booking_transition_email_outbox
         WHERE booking_id='d6000000-0000-4000-8000-000000000010' AND event_type='reschedule')<>1 THEN
    RAISE EXCEPTION 'reschedule replay/outbox failed: % / %',v_result,v_replay;
  END IF;
  v_wait_token:=(v_result->'promoted_waitlist'->>'claim_capability_token')::uuid;
  v_result:=public.claim_waitlist_with_management_capability(v_wait_token,
    'd6000000-0000-4000-8000-000000000086');
  v_replay:=public.claim_waitlist_with_management_capability(v_wait_token,
    'd6000000-0000-4000-8000-000000000086');
  IF v_result->>'outcome'<>'booked' OR v_replay->>'idempotent'<>'true'
     OR (SELECT count(*) FROM public.bookings
       WHERE id=(SELECT booked_booking_id FROM public.booking_waitlist_entries
         WHERE id='d6000000-0000-4000-8000-000000000030'))<>1 THEN
    RAISE EXCEPTION 'reschedule freed-slot auto-book/replay failed: % / %',v_result,v_replay;
  END IF;
  IF public.inspect_booking_management_capability(v_cancel,'cancel')->>'code'<>'stale_booking' THEN
    RAISE EXCEPTION 'pre-reschedule cancel capability did not become stale';
  END IF;
  v_cancel:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000010',
    'cancel',transaction_timestamp()+interval '1 hour')->>'token_id')::uuid;
  v_past:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000011',
    'cancel',transaction_timestamp()+interval '5 minutes')->>'token_id')::uuid;
  IF public.cancel_booking_with_management_capability(v_past,
      'd6000000-0000-4000-8000-000000000083')->>'code'<>'too_late' THEN
    RAISE EXCEPTION 'past appointment cancellation accepted';
  END IF;
  v_past:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000014',
    'cancel',transaction_timestamp()+interval '5 minutes')->>'token_id')::uuid;
  v_result:=public.cancel_booking_with_management_capability(v_past,
    'd6000000-0000-4000-8000-000000000087');
  IF v_result->>'code'<>'cancelled'
     OR v_result->'promoted_waitlist'->>'waitlist_entry_id'<>'d6000000-0000-4000-8000-000000000031'
     OR (v_result->'promoted_waitlist'->>'expires_at')::timestamptz>
       transaction_timestamp()+interval '10 minutes'
     OR (SELECT status FROM public.bookings WHERE id='d6000000-0000-4000-8000-000000000014')<>'cancelled' THEN
    RAISE EXCEPTION 'late cancellation depended on invalid waitlist expiry: %',v_result;
  END IF;
  v_near_reschedule:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000015',
    'reschedule',transaction_timestamp()+interval '5 minutes')->>'token_id')::uuid;
  v_result:=public.reschedule_booking_with_management_capability(v_near_reschedule,
    'd6000000-0000-4000-8000-000000000092',transaction_timestamp()+interval '8 days',
    transaction_timestamp()+interval '8 days 30 minutes');
  IF v_result->>'code'<>'rescheduled' OR v_result->'cancel_preview' IS NULL
     OR v_result->'promoted_waitlist'->>'waitlist_entry_id'<>'d6000000-0000-4000-8000-000000000032'
     OR (SELECT start_time_utc FROM public.bookings
       WHERE id='d6000000-0000-4000-8000-000000000015')<>transaction_timestamp()+interval '8 days' THEN
    RAISE EXCEPTION 'near-term reschedule/promotion contract failed: %',v_result;
  END IF;
  v_result:=public.cancel_booking_with_management_capability(v_cancel,
    'd6000000-0000-4000-8000-000000000084');
  v_replay:=public.cancel_booking_with_management_capability(v_cancel,
    'd6000000-0000-4000-8000-000000000084');
  IF v_result->>'code'<>'cancelled' OR v_replay->>'idempotent'<>'true'
     OR v_replay->'cancel_preview' IS NULL
     OR EXISTS(SELECT 1 FROM public.booking_management_capabilities
       WHERE booking_id='d6000000-0000-4000-8000-000000000010'
         AND action IN('confirm','reschedule','cancel','card_manage')
         AND consumed_at IS NULL AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'terminal cancellation/replay/revoke failed: % / %',v_result,v_replay;
  END IF;
  v_group:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000020',
    'group_reschedule',transaction_timestamp()+interval '1 hour')->>'token_id')::uuid;
  v_result:=public.reschedule_group_booking_with_management_capability(v_group,
    'd6000000-0000-4000-8000-000000000085',jsonb_build_array(
      jsonb_build_object('booking_id','d6000000-0000-4000-8000-000000000020','start_time_utc',transaction_timestamp()+interval '6 days','end_time_utc',transaction_timestamp()+interval '6 days 30 minutes'),
      jsonb_build_object('booking_id','d6000000-0000-4000-8000-000000000021','start_time_utc',transaction_timestamp()+interval '6 days 1 hour','end_time_utc',transaction_timestamp()+interval '6 days 1 hour 30 minutes')));
  IF v_result->>'code'<>'group_rescheduled' OR jsonb_array_length(v_result->'booking_ids')<>2
     OR (SELECT count(*) FROM public.customer_booking_transition_email_outbox
       WHERE booking_id IN('d6000000-0000-4000-8000-000000000020','d6000000-0000-4000-8000-000000000021')
         AND event_type='reschedule')<>2 THEN
    RAISE EXCEPTION 'whole-party reschedule failed: %',v_result;
  END IF;
  IF (public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000021',
    'group_cancel',transaction_timestamp()+interval '10 minutes')->>'code')<>'group_scope_invalid' THEN
    RAISE EXCEPTION 'member promoted to organizer whole-party scope';
  END IF;

  v_member_confirm:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000021',
    'confirm',transaction_timestamp()+interval '10 minutes')->>'token_id')::uuid;
  v_result:=public.confirm_booking_with_management_capability(v_member_confirm,
    'd6000000-0000-4000-8000-000000000088');
  v_replay:=public.confirm_booking_with_management_capability(v_member_confirm,
    'd6000000-0000-4000-8000-000000000088');
  IF v_result->>'attendance_status'<>'confirmed' OR v_result->>'scope_kind'<>'member_own'
     OR v_result->>'rsvp_semantic'<>'confirm' OR v_replay->>'idempotent'<>'true'
     OR (SELECT attendance_status FROM public.bookings WHERE id='d6000000-0000-4000-8000-000000000021')<>'confirmed'
     OR (SELECT attendance_status FROM public.bookings WHERE id='d6000000-0000-4000-8000-000000000020')<>'pending' THEN
    RAISE EXCEPTION 'member-only confirm RSVP truth failed: % / %',v_result,v_replay;
  END IF;
  v_org_confirm:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000020',
    'confirm',transaction_timestamp()+interval '10 minutes')->>'token_id')::uuid;
  v_result:=public.confirm_booking_with_management_capability(v_org_confirm,
    'd6000000-0000-4000-8000-000000000091');
  IF v_result->>'scope_kind'<>'organizer_own' OR v_result->>'rsvp_semantic'<>'confirm'
     OR v_result->>'attendance_status'<>'confirmed'
     OR (SELECT attendance_status FROM public.bookings
       WHERE id='d6000000-0000-4000-8000-000000000021')<>'confirmed' THEN
    RAISE EXCEPTION 'organizer own-spot RSVP scope failed: %',v_result;
  END IF;
  v_member_cancel:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000023',
    'cancel',transaction_timestamp()+interval '10 minutes')->>'token_id')::uuid;
  v_result:=public.cancel_booking_with_management_capability(v_member_cancel,
    'd6000000-0000-4000-8000-000000000089');
  v_replay:=public.cancel_booking_with_management_capability(v_member_cancel,
    'd6000000-0000-4000-8000-000000000089');
  IF v_result->>'attendance_status'<>'declined' OR v_result->>'scope_kind'<>'member_own'
     OR v_result->>'rsvp_semantic'<>'decline' OR v_replay->>'idempotent'<>'true'
     OR (SELECT status||':'||attendance_status FROM public.bookings
       WHERE id='d6000000-0000-4000-8000-000000000023')<>'cancelled:declined'
     OR (SELECT status FROM public.bookings WHERE id='d6000000-0000-4000-8000-000000000022')<>'confirmed' THEN
    RAISE EXCEPTION 'member-only decline RSVP truth failed: % / %',v_result,v_replay;
  END IF;

  v_card:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000012',
    'card_manage',transaction_timestamp()+interval '10 minutes')->>'token_id')::uuid;
  v_result:=public.inspect_booking_management_capability(v_card,'card_manage');
  v_card_claim:=public.claim_booking_card_management_operation(v_card,
    'd6000000-0000-4000-8000-000000000090',v_result->'card_manage'->>'card_fingerprint');
  IF v_card_claim->>'code'<>'claimed' OR v_card_claim->'provider_material'->>'card_id'<>'card_qa' THEN
    RAISE EXCEPTION 'card remove pre-provider claim failed: %',v_card_claim;
  END IF;
  v_replay:=public.claim_booking_card_management_operation(v_card,
    'd6000000-0000-4000-8000-000000000090',v_result->'card_manage'->>'card_fingerprint');
  IF v_replay->>'code'<>'claimed' OR v_replay->>'attempt_replay'<>'true'
     OR v_replay->>'operation_id'<>v_card_claim->>'operation_id'
     OR v_replay->>'provider_idempotency_key'<>v_card_claim->>'provider_idempotency_key' THEN
    RAISE EXCEPTION 'card remove response-loss attempt is not replayable: %',v_replay;
  END IF;
  UPDATE public.booking_card_management_operations SET created_at=transaction_timestamp()-interval '10 minutes'
  WHERE id=(v_card_claim->>'operation_id')::uuid;
  SELECT r INTO v_replay FROM public.reconcile_stale_booking_card_management_operations(10) r
  WHERE r->>'operation_id'=v_card_claim->>'operation_id' LIMIT 1;
  IF v_replay->>'code'<>'reconcile_required'
     OR v_replay->>'provider_idempotency_key'<>v_card_claim->>'provider_idempotency_key' THEN
    RAISE EXCEPTION 'stale remove operation was terminalized instead of recoverable: %',v_replay;
  END IF;
  v_result:=public.complete_booking_card_management_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','',NULL);
  IF v_result->>'code'<>'invalid_completion' THEN RAISE EXCEPTION 'card success without receipt accepted'; END IF;
  v_result:=public.complete_booking_card_management_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','square-remove-card-d600',NULL);
  v_replay:=public.complete_booking_card_management_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','square-remove-card-d600',NULL);
  IF v_result->>'code'<>'removed' OR v_replay->>'idempotent'<>'true'
     OR (SELECT noshow_card_id IS NOT NULL FROM public.bookings
       WHERE id='d6000000-0000-4000-8000-000000000012') THEN
    RAISE EXCEPTION 'card remove completion/replay failed: % / %',v_result,v_replay;
  END IF;

  v_card_save:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000013',
    'card_manage',transaction_timestamp()+interval '10 minutes')->>'token_id')::uuid;
  v_card_claim:=public.claim_booking_card_save_operation(v_card_save,
    'd6000000-0000-4000-8000-000000000093','square','save_card',repeat('e',64));
  IF v_card_claim->>'code'<>'claimed' OR v_card_claim->>'mode'<>'save_card' THEN
    RAISE EXCEPTION 'square save pre-provider claim failed: %',v_card_claim;
  END IF;
  v_replay:=public.claim_booking_card_save_operation(v_card_save,
    'd6000000-0000-4000-8000-000000000093','square','save_card',repeat('e',64));
  IF v_replay->>'code'<>'claimed' OR v_replay->>'attempt_replay'<>'true'
     OR v_replay->>'operation_id'<>v_card_claim->>'operation_id'
     OR v_replay->>'provider_idempotency_key'<>v_card_claim->>'provider_idempotency_key' THEN
    RAISE EXCEPTION 'card save response-loss attempt is not replayable: %',v_replay;
  END IF;
  UPDATE public.booking_card_save_operations SET created_at=transaction_timestamp()-interval '10 minutes'
  WHERE id=(v_card_claim->>'operation_id')::uuid;
  SELECT r INTO v_replay FROM public.reconcile_stale_booking_card_save_operations(10) r
  WHERE r->>'operation_id'=v_card_claim->>'operation_id' LIMIT 1;
  IF v_replay->>'code'<>'reconcile_required'
     OR v_replay->>'provider_idempotency_key'<>v_card_claim->>'provider_idempotency_key' THEN
    RAISE EXCEPTION 'stale save operation was terminalized instead of recoverable: %',v_replay;
  END IF;
  v_result:=public.complete_booking_card_save_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','square-card-create-d600','card_saved_d600','customer_saved_d600','visa','4242',
    transaction_timestamp(),NULL,NULL);
  IF v_result->>'code'<>'invalid_completion' THEN
    RAISE EXCEPTION 'square save accepted missing consent material: %',v_result;
  END IF;
  v_result:=public.complete_booking_card_save_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','square-card-create-d600','card_saved_d600','customer_saved_d600','visa','4242',
    transaction_timestamp(),jsonb_build_object('policyText','QA consent','feeCents',0),NULL);
  v_replay:=public.complete_booking_card_save_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','square-card-create-d600','card_saved_d600','customer_saved_d600','visa','4242',
    transaction_timestamp(),jsonb_build_object('policyText','QA consent','feeCents',0),NULL);
  IF v_result->>'code'<>'saved' OR v_replay->>'idempotent'<>'true'
     OR (SELECT noshow_card_id||':'||noshow_card_last4 FROM public.bookings
       WHERE id='d6000000-0000-4000-8000-000000000013')<>'card_saved_d600:4242' THEN
    RAISE EXCEPTION 'square card save completion/replay failed: % / %',v_result,v_replay;
  END IF;
  v_card_setup:=(public.mint_booking_management_capability(
    'd6000000-0000-4000-8000-000000000001','d6000000-0000-4000-8000-000000000015',
    'card_manage',transaction_timestamp()+interval '10 minutes')->>'token_id')::uuid;
  v_card_claim:=public.claim_booking_card_save_operation(v_card_setup,
    'd6000000-0000-4000-8000-000000000094','stripe','setup_intent',repeat('f',64));
  v_result:=public.complete_booking_card_save_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','seti_d600',NULL,'unexpected_customer',NULL,NULL,NULL,NULL,NULL);
  IF v_result->>'code'<>'invalid_completion' THEN
    RAISE EXCEPTION 'setup intent accepted card/customer persistence material: %',v_result;
  END IF;
  v_result:=public.complete_booking_card_save_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','seti_d600',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
  v_replay:=public.complete_booking_card_save_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','seti_d600',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
  IF v_result->>'code'<>'setup_created' OR v_result->>'provider_reference'<>'seti_d600'
     OR v_result->>'finalize_token_id' IS NULL OR v_replay->>'idempotent'<>'true'
     OR v_replay->>'finalize_token_id'<>v_result->>'finalize_token_id'
     OR (SELECT noshow_card_id FROM public.bookings
       WHERE id='d6000000-0000-4000-8000-000000000015') IS NOT NULL THEN
    RAISE EXCEPTION 'stripe setup durable result/replay failed: % / %',v_result,v_replay;
  END IF;
  v_card_finalize:=(v_result->>'finalize_token_id')::uuid;
  v_card_claim:=public.claim_booking_card_save_operation(v_card_finalize,
    'd6000000-0000-4000-8000-000000000095','stripe','save_card',repeat('a',64));
  IF v_card_claim->>'code'<>'claimed' OR v_card_claim->>'mode'<>'save_card' THEN
    RAISE EXCEPTION 'stripe finalize pre-provider claim failed: %',v_card_claim;
  END IF;
  v_result:=public.complete_booking_card_save_operation(
    (v_card_claim->>'operation_id')::uuid,(v_card_claim->>'attempt_token')::uuid,
    'succeeded','pm_d600','pm_d600','cus_d600','visa','4242',transaction_timestamp(),
    jsonb_build_object('policyText','QA consent','feeCents',0),NULL);
  IF v_result->>'code'<>'saved' OR v_result->>'provider'<>'stripe'
     OR (SELECT noshow_card_id||':'||noshow_card_last4 FROM public.bookings
       WHERE id='d6000000-0000-4000-8000-000000000015')<>'pm_d600:4242' THEN
    RAISE EXCEPTION 'stripe final card persistence failed: %',v_result;
  END IF;
END;
$behavior$;

ROLLBACK;
