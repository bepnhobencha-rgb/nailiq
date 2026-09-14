-- Offline disposable QA only: synthetic rows and all business mutations ROLLBACK.
-- Runner must disable cron, outbound notifications, SMS/email/call and charge dispatch.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '40s';
SELECT set_config('request.jwt.claim.role', 'service_role', true);
CREATE TEMP TABLE qa_incentive_results(case_name text, evidence jsonb) ON COMMIT DROP;

-- These temporary adapters call the actual four public quote/create engines.
CREATE FUNCTION pg_temp.incentive_quote(flow text, p jsonb, proof uuid) RETURNS jsonb
LANGUAGE plpgsql AS $adapter$
BEGIN
  IF flow = 'individual' THEN
    RETURN public.quote_public_booking((p->>'salon_id')::uuid,(p->>'service_id')::uuid,
      (p->>'staff_id')::uuid,(p->>'start')::timestamptz,(p->>'end')::timestamptz,
      ARRAY[]::uuid[],NULL,(p->>'voucher_id')::uuid,p->>'phone',p->>'email',
      (p->>'apply_email_discount')::boolean,proof);
  ELSIF flow = 'group' THEN
    RETURN public.quote_group_booking((p->>'salon_id')::uuid,p->'members',NULL,
      p->>'phone',p->>'email',(p->>'apply_email_discount')::boolean,proof);
  ELSIF flow = 'sequence' THEN
    RETURN public.quote_public_booking_sequence(p || jsonb_build_object('otp_session_id',proof));
  ELSE
    RETURN public.quote_public_group_booking_sequences(p || jsonb_build_object('otp_session_id',proof));
  END IF;
END;
$adapter$;
CREATE FUNCTION pg_temp.incentive_create(flow text,p jsonb,q jsonb,proof uuid) RETURNS jsonb
LANGUAGE plpgsql AS $adapter$
BEGIN
  IF flow = 'individual' THEN
    RETURN public.create_public_booking((p->>'salon_id')::uuid,(p->>'service_id')::uuid,
      (p->>'staff_id')::uuid,'Synthetic R09 Booker',p->>'phone',(p->>'start')::timestamptz,
      (p->>'end')::timestamptz,'confirmed','R09 synthetic QA',ARRAY[]::uuid[],p->>'email',
      NULL,NULL,(p->>'voucher_id')::uuid,(p->>'apply_email_discount')::boolean,
      (p->>'request_id')::uuid,q->>'pricing_fingerprint',proof);
  ELSIF flow = 'group' THEN
    RETURN public.create_group_bookings((p->>'salon_id')::uuid,p->'members',NULL,
      p->>'phone',p->>'email',(p->>'apply_email_discount')::boolean,
      (p->>'request_id')::uuid,q->>'pricing_fingerprint',proof);
  ELSIF flow = 'sequence' THEN
    RETURN public.create_public_booking_sequence(p || jsonb_build_object(
      'expected_pricing_fingerprint',q->>'pricing_fingerprint','otp_session_id',proof,
      'health_acknowledged',false,'sms_consent',false,'notification_language','vi'));
  ELSE
    RETURN public.create_public_group_booking_sequences(p || jsonb_build_object(
      'expected_pricing_fingerprint',q->>'pricing_fingerprint','otp_session_id',proof,
      'health_acknowledged',false,'sms_consent',false,'notification_language','vi'));
  END IF;
END;
$adapter$;

DO $qa$
#variable_conflict use_variable
DECLARE
  s uuid := 'a9090000-0000-4000-8000-000000000001';
  sv uuid := 'a9090000-0000-4000-8000-000000000002';
  sv2 uuid := 'a9090000-0000-4000-8000-000000000003';
  st uuid := 'a9090000-0000-4000-8000-000000000004';
  st2 uuid := 'a9090000-0000-4000-8000-000000000005';
  p jsonb; q jsonb; q2 jsonb; r jsonb; replay jsonb; lines jsonb; customer jsonb;
  cp uuid; otp uuid; email_otp uuid; alternate uuid; request_id uuid; voucher uuid;
  b uuid; f text; ch text; phone text; start_at timestamptz; retry_at timestamptz; idx integer := 0;
  before_count integer; before_visits integer; claimed_at timestamptz;
  deposit_args jsonb; material jsonb; operation jsonb; operation_replay jsonb;
  paid_booking uuid; paid_operation uuid; bad_kind text; before_operations integer;
BEGIN
  IF current_setting('cron.launch_active_jobs',true) IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'Offline runner must keep cron OFF';
  END IF;
  IF EXISTS(SELECT 1 FROM public.salons WHERE id=s)
    OR EXISTS(SELECT 1 FROM public.client_profiles WHERE phone LIKE '160455509%') THEN
    RAISE EXCEPTION 'Synthetic R09 namespace occupied';
  END IF;
  INSERT INTO public.service_categories(slug,name_en,name_vi)
  VALUES('e2e-r09-incentives','Synthetic R09 Incentives','Synthetic R09 Incentives');
  INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete,
    subscription_plan,subscription_status,is_beta,resources_enabled,phone_otp_enabled,
    noshow_protection_enabled,opening_hours,feature_flags,tax_lines,payment_provider,
    stripe_connect_account_id,stripe_connect_charges_enabled)
  VALUES(s,'e2e-r09-incentives','Synthetic R09 Incentives','16045550900','UTC','CAD',true,
    'premium','active',true,false,true,false,
    '{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}',
    '{"group_booking_enabled":true,"group_multi_service_booking_enabled":true}',
    '[]',NULL,NULL,false);
  INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,buffer_minutes,prep_minutes,is_addon,addon_timing,category)
  VALUES(sv,s,'Synthetic R09 Main',5000,30,0,0,false,'sequential','e2e-r09-incentives'),
    (sv2,s,'Synthetic R09 Second',1000,20,0,0,false,'sequential','e2e-r09-incentives');
  INSERT INTO public.staff(id,salon_id,name,status)
  VALUES(st,s,'Synthetic R09 Staff One','active'),(st2,s,'Synthetic R09 Staff Two','active');
  INSERT INTO public.staff_services(staff_id,service_id) VALUES(st,sv),(st,sv2),(st2,sv),(st2,sv2);
  INSERT INTO public.platform_flags(key,enabled,description)
  VALUES('feature_multi_service_booking',true,'Transactional R09 QA'),
    ('feature_group_multi_service_booking',true,'Transactional R09 QA')
  ON CONFLICT(key) DO UPDATE SET enabled=excluded.enabled;
  r := public.configure_multi_service_booking_qa_salon(s,true,'ENABLE_MULTI_SERVICE_QA');
  IF r->>'code' IS DISTINCT FROM 'enabled' THEN RAISE EXCEPTION 'QA config failed: %',r; END IF;
  UPDATE public.salons SET phone_otp_enabled=false WHERE id=s;

  -- Phone proof is typed and fresh; legacy profile timestamps cannot replace it.
  FOREACH ch IN ARRAY ARRAY['sms','email','staff_attested','demo','legacy_unverified'] LOOP
    INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel)
    VALUES('16045550990',s,ch) RETURNING id INTO otp;
    IF public.booking_incentive_phone_ownership(otp,s,'+1 (604) 555-0990',false)
      IS DISTINCT FROM (ch='sms') THEN RAISE EXCEPTION 'Bad channel gate: %',ch; END IF;
    IF public.booking_incentive_phone_ownership(otp,st,'16045550990',false)
      OR public.booking_incentive_phone_ownership(otp,s,'16045550991',false) THEN
      RAISE EXCEPTION 'Wrong tenant/phone accepted';
    END IF;
    INSERT INTO qa_incentive_results VALUES('helper-'||ch,jsonb_build_object('passed',true));
  END LOOP;
  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel)
  VALUES('16045550990',s,'sms') RETURNING id INTO otp;
  UPDATE public.phone_otp_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=otp;
  IF public.booking_incentive_phone_ownership(otp,s,'16045550990',false) THEN RAISE EXCEPTION 'Expired proof accepted'; END IF;
  UPDATE public.phone_otp_sessions SET expires_at='infinity',verified_at=clock_timestamp() WHERE id=otp;
  IF public.booking_incentive_phone_ownership(otp,s,'16045550990',false) THEN RAISE EXCEPTION 'Infinite expiry accepted'; END IF;
  UPDATE public.phone_otp_sessions SET expires_at=clock_timestamp()+interval '1 hour',verified_at=clock_timestamp()+interval '1 minute' WHERE id=otp;
  IF public.booking_incentive_phone_ownership(otp,s,'16045550990',false) THEN RAISE EXCEPTION 'Future proof accepted'; END IF;
  INSERT INTO qa_incentive_results VALUES('helper-timestamps',jsonb_build_object('passed',true));

  FOREACH f IN ARRAY ARRAY['individual','group','sequence','group_sequence'] LOOP
    idx := idx+1; phone := '1604555092'||idx; request_id := extensions.gen_random_uuid();
    start_at := date_trunc('day',now()+interval '8 days')+idx*interval '2 hours';
    INSERT INTO public.client_profiles(phone,name,email,visit_count,email_discount_claimed_at,phone_verified_at)
    VALUES(phone,'Synthetic R09 Victim','victim@example.test',7,NULL,now()) RETURNING id INTO cp;
    INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES(phone,s,'email') RETURNING id INTO email_otp;
    INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES(phone,s,'sms') RETURNING id INTO otp;
    INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES(phone,s,'sms') RETURNING id INTO alternate;
    customer := jsonb_build_object('name','Synthetic R09 Booker','phone',phone,'email','booker@example.test');
    lines := jsonb_build_array(
      jsonb_build_object('line_id',extensions.gen_random_uuid(),'position',0,'service_id',sv,'staff_preference',st,'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb),
      jsonb_build_object('line_id',extensions.gen_random_uuid(),'position',1,'service_id',sv2,'staff_preference',st,'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb));
    IF f='individual' THEN
      p := jsonb_build_object('salon_id',s,'service_id',sv,'staff_id',st,'start',start_at,'end',start_at+interval '30 minutes',
        'phone',phone,'email','booker@example.test','request_id',request_id,'apply_email_discount',true,'voucher_id',NULL);
    ELSIF f='group' THEN
      p := jsonb_build_object('salon_id',s,'phone',phone,'email','booker@example.test','request_id',request_id,'apply_email_discount',true,
        'members',jsonb_build_array(
          jsonb_build_object('service_id',sv,'staff_id',st,'client_name','Synthetic R09 Booker','client_phone',phone,'start_time_utc',start_at,'end_time_utc',start_at+interval '30 minutes','addon_service_ids','[]'::jsonb),
          jsonb_build_object('service_id',sv,'staff_id',st2,'client_name','Synthetic R09 Guest','client_phone','16045550988','start_time_utc',start_at,'end_time_utc',start_at+interval '30 minutes','addon_service_ids','[]'::jsonb)));
    ELSIF f='sequence' THEN
      p := jsonb_build_object('contract_version',1,'salon_id',s,'request_id',request_id,'requested_start_time_utc',start_at,
        'same_staff_for_all',true,'voucher_code',NULL,'apply_email_discount',true,'customer',customer,'lines',lines);
    ELSE
      p := jsonb_build_object('contract_version',1,'salon_id',s,'group_request_id',request_id,'requested_anchor_utc',start_at,
        'seat_together',false,'apply_email_discount',true,'organizer',customer,
        'members',jsonb_build_array(
          jsonb_build_object('member_index',0,'member_request_id',extensions.gen_random_uuid(),'requested_start_time_utc',start_at,'same_staff_for_all',true,'customer',customer,'lines',lines),
          jsonb_build_object('member_index',1,'member_request_id',extensions.gen_random_uuid(),'requested_start_time_utc',start_at,'same_staff_for_all',false,
            'customer',jsonb_build_object('name','Synthetic R09 Guest','phone','16045550988','email',NULL),
            'lines',jsonb_build_array(jsonb_build_object('line_id',extensions.gen_random_uuid(),'position',0,'service_id',sv,'staff_preference',st2,'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb)))));
    END IF;
    q := pg_temp.incentive_quote(f,p,email_otp);
    IF q->>'code' IS DISTINCT FROM 'phone_verification_required' THEN RAISE EXCEPTION '% email quote leaked discount: %',f,q; END IF;
    q := pg_temp.incentive_quote(f,p,NULL);
    IF q->>'code' IS DISTINCT FROM 'phone_verification_required' THEN RAISE EXCEPTION '% missing proof quote accepted: %',f,q; END IF;
    q := pg_temp.incentive_quote(f,p,otp);
    q2 := pg_temp.incentive_quote(f,p,alternate);
    IF q->>'success' IS DISTINCT FROM 'true' OR (q->>'email_discount_cents')::integer<>200
      OR q->>'pricing_fingerprint' IS DISTINCT FROM q2->>'pricing_fingerprint' THEN
      RAISE EXCEPTION '% valid proof quote/fingerprint failed: %',f,q;
    END IF;
    IF f='individual' THEN
      q2 := public.quote_public_booking(s,sv,st,start_at,start_at+interval '30 minutes',
        ARRAY[]::uuid[],NULL,NULL,substring(phone from 2),'booker@example.test',true,otp);
      IF q2->>'success' IS DISTINCT FROM 'true' OR (q2->>'email_discount_cents')::integer<>200 THEN
        RAISE EXCEPTION 'Equivalent bare NANP quote lost proved phone: %',q2;
      END IF;
    END IF;
    SELECT count(*) INTO before_count FROM public.bookings WHERE salon_id=s;
    SELECT visit_count INTO before_visits FROM public.client_profiles WHERE id=cp;
    r := pg_temp.incentive_create(f,p,q,email_otp);
    IF r->>'code' IS DISTINCT FROM 'phone_verification_required'
      OR (SELECT count(*) FROM public.bookings WHERE salon_id=s)<>before_count
      OR (SELECT email_discount_claimed_at FROM public.client_profiles WHERE id=cp) IS NOT NULL
      OR (SELECT visit_count FROM public.client_profiles WHERE id=cp)<>before_visits THEN
      RAISE EXCEPTION '% rejected create mutated victim: %',f,r;
    END IF;
    r := pg_temp.incentive_create(f,p,q,otp);
    IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION '% valid SMS create failed: %',f,r; END IF;
    SELECT consumed_by_booking_id INTO b FROM public.phone_otp_sessions WHERE id=otp;
    IF b IS NULL OR NOT EXISTS(SELECT 1 FROM public.bookings WHERE id=b AND client_profile_id=cp AND otp_session_id=otp)
      OR (SELECT email_discount_claimed_at FROM public.client_profiles WHERE id=cp) IS NULL THEN
      RAISE EXCEPTION '% atomic proof/claim/booking binding missing',f;
    END IF;
    claimed_at := (SELECT email_discount_claimed_at FROM public.client_profiles WHERE id=cp);
    UPDATE public.phone_otp_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=otp;
    replay := pg_temp.incentive_create(f,p,q,otp);
    IF replay->>'success' IS DISTINCT FROM 'true' OR replay->>'idempotent' IS DISTINCT FROM 'true'
      OR (SELECT count(*) FROM public.bookings WHERE salon_id=s)<>before_count+(CASE WHEN f IN ('group','group_sequence') THEN 2 ELSE 1 END)
      OR (SELECT email_discount_claimed_at FROM public.client_profiles WHERE id=cp) IS DISTINCT FROM claimed_at THEN
      RAISE EXCEPTION '% consumed/expired committed replay failed: %',f,replay;
    END IF;
    INSERT INTO qa_incentive_results VALUES(f||'-email-discount',jsonb_build_object('passed',true,
      'email_rejected_before_mutation',true,'fresh_sms_discount_cents',200,'proof_excluded_from_pricing_fingerprint',true,
      'sms_with_booking_otp_off',true,'atomic_claim_and_session_binding',true,'expired_committed_replay',true));

    -- Once-per-phone remains once-per-phone after a fresh proof is supplied.
    retry_at := start_at+interval '2 days';
    q2 := public.quote_public_booking(s,sv,st,retry_at,retry_at+interval '30 minutes',
      ARRAY[]::uuid[],NULL,NULL,phone,'changed-email@example.test',true,alternate);
    IF q2->>'success' IS DISTINCT FROM 'true' OR (q2->>'email_discount_cents')::integer<>0 THEN
      RAISE EXCEPTION 'Phone discount could be claimed again with different email: %',q2;
    END IF;
    q2 := public.quote_public_booking(s,sv,st,retry_at,retry_at+interval '30 minutes',
      ARRAY[]::uuid[],NULL,NULL,substring(phone from 2),'changed-email@example.test',true,alternate);
    IF q2->>'success' IS DISTINCT FROM 'true' OR (q2->>'email_discount_cents')::integer<>0 THEN
      RAISE EXCEPTION 'Equivalent phone format bypassed once-per-phone: %',q2;
    END IF;

    -- Explicit opt-out still books via email, without borrowing CRM identity.
    p := p || jsonb_build_object('apply_email_discount',false);
    IF f='individual' THEN
      p := p || jsonb_build_object('start',retry_at,'end',retry_at+interval '30 minutes','request_id',extensions.gen_random_uuid());
    ELSIF f='group' THEN
      p := p || jsonb_build_object('request_id',extensions.gen_random_uuid(),'members',
        (SELECT jsonb_agg(value || jsonb_build_object('start_time_utc',retry_at,'end_time_utc',retry_at+interval '30 minutes'))
          FROM jsonb_array_elements(p->'members')));
    ELSIF f='sequence' THEN
      p := p || jsonb_build_object('requested_start_time_utc',retry_at,'request_id',extensions.gen_random_uuid());
    ELSE
      p := p || jsonb_build_object('requested_anchor_utc',retry_at,'group_request_id',extensions.gen_random_uuid(),'members',
        (SELECT jsonb_agg(value || jsonb_build_object('requested_start_time_utc',retry_at,'member_request_id',extensions.gen_random_uuid()))
          FROM jsonb_array_elements(p->'members')));
    END IF;
    q2 := pg_temp.incentive_quote(f,p,email_otp);
    r := pg_temp.incentive_create(f,p,q2,email_otp);
    IF q2->>'success' IS DISTINCT FROM 'true' OR (q2->>'email_discount_cents')::integer<>0
      OR r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION '% email opt-out booking regressed: % %',f,q2,r; END IF;
    SELECT id INTO b FROM public.bookings WHERE salon_id=s AND client_phone=phone AND start_time_utc=retry_at;
    IF b IS NULL OR NOT EXISTS(SELECT 1 FROM public.bookings WHERE id=b AND client_profile_id IS NULL AND is_party_member IS FALSE) THEN
      RAISE EXCEPTION '% email opt-out conflated CRM authority with contact/Party status',f;
    END IF;
    IF (SELECT email_discount_claimed_at FROM public.client_profiles WHERE id=cp) IS DISTINCT FROM claimed_at THEN
      RAISE EXCEPTION '% no-discount booking changed prior discount receipt',f;
    END IF;
    INSERT INTO qa_incentive_results VALUES(f||'-email-optout',jsonb_build_object('passed',true,
      'discount_cents',0,'crm_profile_unlinked',true,'ordinary_contact_booking',true,'once_per_phone_preserved',true));
  END LOOP;

  -- Personalized voucher ownership is independent of the $2 checkbox.
  FOREACH f IN ARRAY ARRAY['individual','sequence'] LOOP
    idx := idx+1; phone := '1604555092'||idx; request_id := extensions.gen_random_uuid();
    start_at := date_trunc('day',now()+interval '9 days')+idx*interval '1 hour';
    INSERT INTO public.client_profiles(phone,name,email,visit_count,email_discount_claimed_at)
    VALUES(phone,'Synthetic Voucher Owner','victim@example.test',7,NULL) RETURNING id INTO cp;
    INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES(phone,s,'email') RETURNING id INTO email_otp;
    INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES(phone,s,'sms') RETURNING id INTO otp;
    INSERT INTO public.vouchers(salon_id,code,kind,client_phone,client_profile_id,amount_off_cents,max_uses,valid_from,expires_at)
    VALUES(s,'R09-PERSONAL-'||idx,'promo',phone,cp,300,1,now()-interval '1 day',now()+interval '10 days') RETURNING id INTO voucher;
    IF f='individual' THEN
      p := jsonb_build_object('salon_id',s,'service_id',sv,'staff_id',st,'start',start_at,'end',start_at+interval '30 minutes',
        'phone',phone,'email','booker@example.test','request_id',request_id,'apply_email_discount',false,'voucher_id',voucher);
    ELSE
      p := jsonb_build_object('contract_version',1,'salon_id',s,'request_id',request_id,'requested_start_time_utc',start_at,
        'same_staff_for_all',true,'voucher_code','R09-PERSONAL-'||idx,'apply_email_discount',false,
        'customer',jsonb_build_object('name','Synthetic R09 Booker','phone',phone,'email','booker@example.test'),'lines',lines);
    END IF;
    q := pg_temp.incentive_quote(f,p,email_otp);
    IF q->>'code' IS DISTINCT FROM 'phone_verification_required' THEN RAISE EXCEPTION '% personal voucher accepted email: %',f,q; END IF;
    q := pg_temp.incentive_quote(f,p,otp);
    IF q->>'success' IS DISTINCT FROM 'true' OR (q->>'voucher_discount_cents')::integer<>300 THEN RAISE EXCEPTION 'SMS voucher quote failed: %',q; END IF;
    r := pg_temp.incentive_create(f,p,q,email_otp);
    IF r->>'code' IS DISTINCT FROM 'phone_verification_required' OR (SELECT used_count FROM public.vouchers WHERE id=voucher)<>0 THEN
      RAISE EXCEPTION 'Rejected voucher create mutated: %',r;
    END IF;
    r := pg_temp.incentive_create(f,p,q,otp);
    replay := pg_temp.incentive_create(f,p,q,otp);
    IF r->>'success' IS DISTINCT FROM 'true' OR replay->>'idempotent' IS DISTINCT FROM 'true'
      OR (SELECT used_count FROM public.vouchers WHERE id=voucher)<>1
      OR (SELECT count(*) FROM public.voucher_redemptions WHERE voucher_id=voucher)<>1 THEN
      RAISE EXCEPTION 'Personal voucher receipt/replay failed: % %',r,replay;
    END IF;
    INSERT INTO qa_incentive_results VALUES(f||'-personal-voucher',jsonb_build_object('passed',true,'single_redemption',true));
  END LOOP;

  -- VIP history is private identity material; no proof means new-customer policy.
  UPDATE public.salons SET payment_provider='stripe',
    stripe_connect_account_id='acct_synthetic_r09_never_dispatch',stripe_connect_charges_enabled=true
  WHERE id=s;
  phone := '16045550971';
  INSERT INTO public.client_profiles(phone,name,is_vip,visit_count) VALUES(phone,'Synthetic VIP',true,10) RETURNING id INTO cp;
  INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,client_profile_id,start_time_utc,end_time_utc,status,price_cents)
  VALUES(s,sv,st,'Synthetic VIP',phone,cp,now()-interval '4 days',now()-interval '4 days'+interval '30 minutes','confirmed',5000);
  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES(phone,s,'email') RETURNING id INTO email_otp;
  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES(phone,s,'sms') RETURNING id INTO otp;
  start_at := date_trunc('day',now()+interval '10 days'); request_id := extensions.gen_random_uuid();
  q := public.quote_public_booking(s,sv,st,start_at,start_at+interval '30 minutes',ARRAY[]::uuid[],NULL,NULL,phone,'vip@example.test',false,NULL);
  r := public.load_public_deposit_payment_material(s,sv,st,start_at,start_at+interval '30 minutes',ARRAY[]::uuid[],NULL,NULL,phone,'vip@example.test',false,request_id,q->>'pricing_fingerprint',email_otp);
  IF r->>'success' IS DISTINCT FROM 'true' OR r->'material'->>'deposit_reason' IS DISTINCT FROM 'new_customer'
    OR (r->'material'->>'amount_cents')::integer<>1000 THEN RAISE EXCEPTION 'Unproved VIP waiver leaked: %',r; END IF;
  r := public.load_public_deposit_payment_material(s,sv,st,start_at,start_at+interval '30 minutes',ARRAY[]::uuid[],NULL,NULL,phone,'vip@example.test',false,request_id,q->>'pricing_fingerprint',otp);
  IF r->>'code' IS DISTINCT FROM 'deposit_not_required' OR r->>'reason' IS DISTINCT FROM 'vip' THEN RAISE EXCEPTION 'Proved VIP policy regressed: %',r; END IF;
  INSERT INTO qa_incentive_results VALUES('deposit-vip-identity',jsonb_build_object('passed',true,'unproved_deposit_cents',1000,'proved_vip_exemption',true));

  phone := '16045550972'; request_id := extensions.gen_random_uuid();
  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES(phone,s,'email') RETURNING id INTO email_otp;
  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES(phone,s,'sms') RETURNING id INTO otp;
  q := public.quote_public_booking(s,sv,st,start_at,start_at+interval '30 minutes',ARRAY[]::uuid[],NULL,NULL,phone,'discount@example.test',true,otp);
  r := public.load_public_deposit_payment_material(s,sv,st,start_at,start_at+interval '30 minutes',ARRAY[]::uuid[],NULL,NULL,phone,'discount@example.test',true,request_id,q->>'pricing_fingerprint',email_otp);
  IF r->>'code' IS DISTINCT FROM 'phone_verification_required' THEN RAISE EXCEPTION 'Deposit prepare lost incentive proof: %',r; END IF;
  material := public.load_public_deposit_payment_material(s,sv,st,start_at,start_at+interval '30 minutes',ARRAY[]::uuid[],NULL,NULL,phone,'discount@example.test',true,request_id,q->>'pricing_fingerprint',otp);
  IF material->>'success' IS DISTINCT FROM 'true' OR (material->'material'->>'amount_cents')::integer<>960 THEN RAISE EXCEPTION 'Discounted material amount changed: %',material; END IF;
  alternate := extensions.gen_random_uuid();
  operation := public.claim_public_deposit_payment_operation(s,sv,st,start_at,start_at+interval '30 minutes',ARRAY[]::uuid[],NULL,NULL,phone,'discount@example.test',true,request_id,q->>'pricing_fingerprint',alternate,otp);
  UPDATE public.phone_otp_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=otp;
  operation_replay := public.claim_public_deposit_payment_operation(s,sv,st,start_at,start_at+interval '30 minutes',ARRAY[]::uuid[],NULL,NULL,phone,'discount@example.test',true,request_id,q->>'pricing_fingerprint',alternate,NULL);
  IF operation->>'success' IS DISTINCT FROM 'true' OR operation_replay->>'success' IS DISTINCT FROM 'true'
    OR operation->>'operation_id' IS DISTINCT FROM operation_replay->>'operation_id'
    OR (SELECT count(*) FROM public.booking_payment_operations WHERE salon_id=s)<>1 THEN
    RAISE EXCEPTION 'Deposit durable claim/replay failed: % %',operation,operation_replay;
  END IF;
  INSERT INTO qa_incentive_results VALUES('deposit-proof-propagation-replay',jsonb_build_object('passed',true,'amount_cents',960,'provider_dispatch',false));

  -- Synthetic receipt only: represent a provider-confirmed payment in this
  -- rollback-only fixture. No provider/charge/refund dispatch is executed.
  paid_operation := (operation->>'operation_id')::uuid;
  UPDATE public.phone_otp_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=otp;
  UPDATE public.booking_payment_operations SET status='succeeded',completed_at=now(),
    result_json='{"synthetic_fixture":true,"status":"succeeded"}',
    provider_payment_id='pi_synthetic_r09_never_dispatch',binding_expires_at=now()+interval '1 hour'
  WHERE id=paid_operation;
  r := public.create_public_booking_with_deposit_payment(s,sv,st,'Synthetic Paid Booker',phone,
    start_at,start_at+interval '30 minutes','confirmed','Synthetic paid receipt',ARRAY[]::uuid[],
    'discount@example.test',NULL,NULL,NULL,true,request_id,q->>'pricing_fingerprint',
    paid_operation,alternate,material->>'material_fingerprint',otp);
  IF r->>'success' IS DISTINCT FROM 'true' OR r->>'code' IS DISTINCT FROM 'booked_and_deposit_bound' THEN
    RAISE EXCEPTION 'Actual canonical paid create/bind failed: %',r;
  END IF;
  paid_booking := (r->>'booking_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.phone_otp_sessions WHERE id=otp AND consumed_by_booking_id=paid_booking)
    OR NOT EXISTS(SELECT 1 FROM public.bookings WHERE id=paid_booking AND deposit_status='paid' AND otp_session_id=otp) THEN
    RAISE EXCEPTION 'Paid fixture lacks consumed SMS/booking binding';
  END IF;
  -- Keep immutable receipt chronology valid, but make the session expire now.
  UPDATE public.phone_otp_sessions SET expires_at=clock_timestamp() WHERE id=otp;
  SELECT count(*) INTO before_count FROM public.bookings WHERE salon_id=s;
  SELECT count(*) INTO before_operations FROM public.booking_payment_operations WHERE salon_id=s;
  replay := public.replay_public_booking_with_deposit_payment(s,sv,st,'Synthetic Paid Booker',phone,
    start_at,start_at+interval '30 minutes','confirmed','Synthetic paid receipt',ARRAY[]::uuid[],
    'discount@example.test',NULL,NULL,NULL,true,request_id,q->>'pricing_fingerprint',
    paid_operation,alternate,material->>'material_fingerprint',otp);
  IF replay->>'success' IS DISTINCT FROM 'true' OR replay->>'code' IS DISTINCT FROM 'booking_payment_replay'
    OR replay->>'booking_id' IS DISTINCT FROM paid_booking::text
    OR replay->>'idempotent' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Consumed expired paid replay failed: %',replay; END IF;
  IF replay->'booking'->>'staff_id' IS DISTINCT FROM st::text
    OR replay->>'operation_id' IS DISTINCT FROM paid_operation::text
    OR replay->>'payment_status' IS DISTINCT FROM 'succeeded'
    OR replay->>'material_fingerprint' IS DISTINCT FROM material->>'material_fingerprint' THEN
    RAISE EXCEPTION 'Paid replay is missing the browser receipt binding';
  END IF;
  replay := public.replay_public_booking_with_deposit_payment(s,sv,st,'Synthetic Paid Booker',phone,
    start_at,start_at+interval '30 minutes','confirmed','Synthetic paid receipt',ARRAY[]::uuid[],
    'discount@example.test',NULL,NULL,NULL,true,request_id,q->>'pricing_fingerprint',
    paid_operation,alternate,material->>'material_fingerprint',NULL);
  IF replay->>'success' IS DISTINCT FROM 'true' OR replay->>'booking_id' IS DISTINCT FROM paid_booking::text THEN
    RAISE EXCEPTION 'Durable paid replay unexpectedly needs unused OTP: %',replay;
  END IF;
  FOREACH bad_kind IN ARRAY ARRAY['salon','request','material','pricing','name'] LOOP
    r := public.replay_public_booking_with_deposit_payment(
      CASE WHEN bad_kind='salon' THEN st ELSE s END,sv,st,
      CASE WHEN bad_kind='name' THEN 'Different Booker' ELSE 'Synthetic Paid Booker' END,phone,
      start_at,start_at+interval '30 minutes','confirmed','Synthetic paid receipt',ARRAY[]::uuid[],
      'discount@example.test',NULL,NULL,NULL,true,request_id,
      CASE WHEN bad_kind='pricing' THEN repeat('f',64) ELSE q->>'pricing_fingerprint' END,
      paid_operation,CASE WHEN bad_kind='request' THEN st ELSE alternate END,
      CASE WHEN bad_kind='material' THEN repeat('f',64) ELSE material->>'material_fingerprint' END,NULL);
    IF r->>'success' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Altered paid % replay accepted: %',bad_kind,r; END IF;
  END LOOP;
  -- A claimed-but-unbound operation, even marked succeeded, is not replay authority.
  UPDATE public.booking_payment_operations SET booking_id=NULL WHERE id=paid_operation;
  r := public.replay_public_booking_with_deposit_payment(s,sv,st,'Synthetic Paid Booker',phone,
    start_at,start_at+interval '30 minutes','confirmed','Synthetic paid receipt',ARRAY[]::uuid[],
    'discount@example.test',NULL,NULL,NULL,true,request_id,q->>'pricing_fingerprint',
    paid_operation,alternate,material->>'material_fingerprint',otp);
  IF r->>'code' IS DISTINCT FROM 'booking_recovery_required' THEN RAISE EXCEPTION 'Unbound paid replay reached create: %',r; END IF;
  UPDATE public.booking_payment_operations SET booking_id=paid_booking WHERE id=paid_operation;
  IF (SELECT count(*) FROM public.bookings WHERE salon_id=s)<>before_count
    OR (SELECT count(*) FROM public.booking_payment_operations WHERE salon_id=s)<>before_operations
    OR EXISTS(SELECT 1 FROM public.booking_payment_operations WHERE salon_id=s AND operation_kind='deposit_refund') THEN
    RAISE EXCEPTION 'Replay-only branch produced new business operations';
  END IF;
  INSERT INTO qa_incentive_results VALUES('paid-replay-only',jsonb_build_object('passed',true,
    'actual_canonical_create_and_bind',true,'consumed_expired_sms_replayed',true,'no_unused_otp_required',true,
    'altered_salons_requests_fingerprints_rejected',true,'unbound_refused',true,'fresh_bookings_or_refunds',0,'provider_dispatch',false));
END;
$qa$;
SELECT jsonb_build_object('status','PASS','cases',jsonb_object_agg(case_name,evidence)) FROM qa_incentive_results;
ROLLBACK;
SELECT jsonb_build_object('rollback_verified',
  NOT EXISTS(SELECT 1 FROM public.salons WHERE slug='e2e-r09-incentives')
  AND NOT EXISTS(SELECT 1 FROM public.client_profiles WHERE phone LIKE '160455509%'));
