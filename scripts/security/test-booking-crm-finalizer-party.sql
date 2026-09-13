-- Offline disposable QA only. Synthetic fixtures, no provider/outbound actions.
-- Functional acceptance after both R09 migrations; every write rolls back.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('request.jwt.claim.role','service_role',true);
CREATE TEMP TABLE qa_r09_crm_checks(scenario text, passed boolean) ON COMMIT DROP;
CREATE TEMP SEQUENCE crm_expiry_trigger_hits;
CREATE FUNCTION pg_temp.delay_synthetic_crm_insert() RETURNS trigger LANGUAGE plpgsql AS $trigger$
BEGIN
  PERFORM nextval('pg_temp.crm_expiry_trigger_hits');
  PERFORM pg_sleep(0.5);
  RETURN NEW;
END;$trigger$;
CREATE TRIGGER qa_r09_expire_during_crm BEFORE INSERT ON public.client_profiles
  FOR EACH ROW WHEN(NEW.name='Synthetic Expiry During CRM') EXECUTE FUNCTION pg_temp.delay_synthetic_crm_insert();
DO $test$
DECLARE
  s uuid:=extensions.gen_random_uuid(); s2 uuid:=extensions.gen_random_uuid();
  sv uuid:=extensions.gen_random_uuid(); st uuid:=extensions.gen_random_uuid();
  cp uuid:=extensions.gen_random_uuid(); cp2 uuid:=extensions.gen_random_uuid();
  b uuid; b2 uuid; o uuid; o2 uuid; g uuid:=extensions.gen_random_uuid();
  lid uuid:=extensions.gen_random_uuid(); cid uuid:=extensions.gen_random_uuid();
  token text:='synthetic-r09-'||extensions.gen_random_uuid(); channel text; n integer:=0;
  r jsonb; before_profile jsonb; before_booking jsonb; before_claim jsonb;
BEGIN
  INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('qa-r09-crm-'||s,'Synthetic CRM','Synthetic CRM');
  INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete)
  VALUES(s,'disposable-r09-crm-'||s,'Synthetic CRM','','UTC','CAD',true),
    (s2,'disposable-r09-crm-'||s2,'Synthetic Other CRM','','UTC','CAD',true);
  INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
  VALUES(sv,s,'Synthetic CRM Service',2000,30,'qa-r09-crm-'||s);
  INSERT INTO public.staff(id,salon_id,name,status) VALUES(st,s,'Synthetic CRM Staff','active');
  INSERT INTO public.client_profiles(id,phone,name,visit_count,phone_verified_at)
  VALUES(cp,'17035550176','Synthetic Known',7,now()-interval '90 days'),
    (cp2,'17035550177','Synthetic Other',9,now()-interval '90 days');
  SELECT to_jsonb(p) INTO before_profile FROM public.client_profiles p WHERE id=cp;

  FOREACH channel IN ARRAY ARRAY['none','email','staff_attested','demo'] LOOP
    n:=n+1;
    INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,client_email,
      start_time_utc,end_time_utc,status,price_cents)
    VALUES(s,sv,st,'Synthetic Declared','17035550176','synthetic-declared@example.test',
      now()+interval '8 days'+n*interval '1 hour',now()+interval '8 days 30 minutes'+n*interval '1 hour','confirmed',2000)
    RETURNING id INTO b;
    o:=NULL;
    IF channel<>'none' THEN
      INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES('17035550176',s,channel) RETURNING id INTO o;
    END IF;
    r:=public.finalize_public_booking_profile(b,o,true);
    IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT client_profile_id FROM public.bookings WHERE id=b) IS NOT NULL
      OR (SELECT to_jsonb(p) FROM public.client_profiles p WHERE id=cp) IS DISTINCT FROM before_profile THEN
      RAISE EXCEPTION 'non-phone finalizer changed global CRM: %',channel;
    END IF;
    IF o IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.phone_otp_sessions WHERE id=o AND consumed_by_booking_id=b) THEN
      RAISE EXCEPTION 'non-phone finalizer lost booking proof: %',channel;
    END IF;
    INSERT INTO qa_r09_crm_checks VALUES('finalizer '||channel||' leaves CRM unchanged and booking intact',true);
  END LOOP;

  INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,client_email,
    start_time_utc,end_time_utc,status,price_cents)
  VALUES(s,sv,st,'Synthetic SMS Owner','17035550176','synthetic-owner@example.test',now()+interval '9 days',
    now()+interval '9 days 30 minutes','confirmed',2000) RETURNING id INTO b;
  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES('17035550176',s,'sms') RETURNING id INTO o;
  r:=public.finalize_public_booking_profile(b,o,true);
  IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT client_profile_id FROM public.bookings WHERE id=b) IS DISTINCT FROM cp
    OR NOT EXISTS(SELECT 1 FROM public.client_profiles WHERE id=cp AND visit_count=8 AND marketing_consent_at IS NOT NULL
      AND phone_verified_at>now()-interval '1 minute') THEN RAISE EXCEPTION 'SMS finalizer failed'; END IF;
  SELECT to_jsonb(p) INTO before_profile FROM public.client_profiles p WHERE id=cp;
  r:=public.finalize_public_booking_profile(b,o,true);
  IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT to_jsonb(p) FROM public.client_profiles p WHERE id=cp) IS DISTINCT FROM before_profile THEN
    RAISE EXCEPTION 'same SMS replay mutated profile'; END IF;
  INSERT INTO qa_r09_crm_checks VALUES('exact SMS links once and replay keeps profile unchanged',true);

  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES('17035550176',s,'sms') RETURNING id INTO o2;
  r:=public.finalize_public_booking_profile(b,o2,true);
  IF r->>'success' IS DISTINCT FROM 'false' OR (SELECT to_jsonb(p) FROM public.client_profiles p WHERE id=cp) IS DISTINCT FROM before_profile
    OR EXISTS(SELECT 1 FROM public.phone_otp_sessions WHERE id=o2 AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'second SMS replaced first binding'; END IF;
  INSERT INTO qa_r09_crm_checks VALUES('another SMS cannot replace a finalized booking proof',true);

  INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents)
  VALUES(s,sv,st,'Synthetic Other Booking','17035550176',now()+interval '10 days',now()+interval '10 days 30 minutes','confirmed',2000) RETURNING id INTO b2;
  r:=public.finalize_public_booking_profile(b2,o,true);
  IF r->>'success' IS DISTINCT FROM 'false' OR (SELECT client_profile_id FROM public.bookings WHERE id=b2) IS NOT NULL THEN
    RAISE EXCEPTION 'consumed SMS transferred between bookings'; END IF;
  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES('17035550176',s2,'sms') RETURNING id INTO o2;
  r:=public.finalize_public_booking_profile(b2,o2,true);
  IF r->>'success' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'foreign salon proof accepted'; END IF;
  INSERT INTO qa_r09_crm_checks VALUES('consumed and foreign-salon proof cannot transfer',true);

  -- A legacy/desk booking may already have a legitimate exact phone FK.
  UPDATE public.bookings SET client_profile_id=cp WHERE id=b2;
  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel) VALUES('17035550176',s,'sms') RETURNING id INTO o2;
  r:=public.finalize_public_booking_profile(b2,o2,false);
  IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT visit_count FROM public.client_profiles WHERE id=cp)<>8 THEN
    RAISE EXCEPTION 'existing authorized FK double counted'; END IF;
  INSERT INTO qa_r09_crm_checks VALUES('existing exact phone FK avoids another visit increment',true);

  INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents)
  VALUES(s,sv,st,'Synthetic Expiry During CRM','17035550175',now()+interval '10 days 2 hours',now()+interval '10 days 2 hours 30 minutes','confirmed',2000) RETURNING id INTO b2;
  INSERT INTO public.phone_otp_sessions(phone,salon_id,verified_channel,verified_at,expires_at)
  VALUES('17035550175',s,'sms',clock_timestamp(),clock_timestamp()+interval '300 milliseconds') RETURNING id INTO o2;
  r:=public.finalize_public_booking_profile(b2,o2,true);
  IF r->>'code' IS DISTINCT FROM 'invalid_otp_session' OR NOT (SELECT is_called FROM pg_temp.crm_expiry_trigger_hits)
    OR EXISTS(SELECT 1 FROM public.client_profiles WHERE phone='17035550175')
    OR EXISTS(SELECT 1 FROM public.bookings WHERE id=b2 AND client_profile_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.phone_otp_sessions WHERE id=o2 AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'expiry during CRM failed to roll back identity mutation'; END IF;
  INSERT INTO qa_r09_crm_checks VALUES('proof expiry during resolver rolls back profile, FK and OTP consumption',true);

  -- Both Party entry points edit booking contact without poisoning global CRM.
  INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents,
    group_id,group_size,is_party_member,is_group_organizer)
  VALUES(s,sv,st,'Synthetic Unclaimed',NULL,now()+interval '11 days',now()+interval '11 days 30 minutes','confirmed',2000,g,2,true,false) RETURNING id INTO b;
  INSERT INTO public.party_links(id,group_id,salon_id,token,expires_at) VALUES(lid,g,s,token,now()+interval '1 day');
  INSERT INTO public.party_link_claims(id,party_link_id,booking_id) VALUES(cid,lid,b);
  SELECT to_jsonb(p) INTO before_profile FROM public.client_profiles p WHERE id=cp;
  r:=public.claim_party_slot(token,cid,'Synthetic Claimed','17035550176',false);
  IF r->>'success' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.bookings WHERE id=b AND client_profile_id IS NULL AND is_party_member=false)
    OR (SELECT to_jsonb(p) FROM public.client_profiles p WHERE id=cp) IS DISTINCT FROM before_profile THEN
    RAISE EXCEPTION 'Party initial claim wrote CRM'; END IF;
  INSERT INTO qa_r09_crm_checks VALUES('Party initial claim has contact with no unproved CRM link',true);
  UPDATE public.bookings SET client_profile_id=cp,otp_session_id=o,verification_method='otp',verification_completed_at=now() WHERE id=b;
  r:=public.update_party_claim_details(token,cid,'Synthetic Changed','17035550177',false);
  IF r->>'success' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.bookings WHERE id=b AND client_profile_id IS NULL
    AND otp_session_id IS NULL AND verification_method IS NULL AND verification_completed_at IS NULL AND client_phone='17035550177')
    OR (SELECT visit_count FROM public.client_profiles WHERE id=cp2)<>9 THEN RAISE EXCEPTION 'Party stale profile/proof retained'; END IF;
  INSERT INTO qa_r09_crm_checks VALUES('Party phone change detaches old CRM and OTP without mutating new CRM',true);

  UPDATE public.bookings SET noshow_card_id='synthetic-card-receipt',noshow_customer_id='synthetic-customer-binding' WHERE id=b;
  SELECT to_jsonb(x) INTO before_booking FROM public.bookings x WHERE id=b;
  SELECT to_jsonb(x) INTO before_claim FROM public.party_link_claims x WHERE id=cid;
  r:=public.update_party_claim_details(token,cid,'Synthetic Protected Change','17035550176',false);
  IF r->>'code' IS DISTINCT FROM 'contact_change_requires_card_review'
    OR (SELECT to_jsonb(x) FROM public.bookings x WHERE id=b) IS DISTINCT FROM before_booking
    OR (SELECT to_jsonb(x) FROM public.party_link_claims x WHERE id=cid) IS DISTINCT FROM before_claim THEN
    RAISE EXCEPTION 'protected Party contact changed identity/history'; END IF;
  INSERT INTO qa_r09_crm_checks VALUES('protected Party edit rejects phone transfer with no booking/claim mutation',true);
  UPDATE public.party_link_claims SET claimed_at=NULL WHERE id=cid;
  r:=public.claim_party_slot(token,cid,'Synthetic Protected Claim','17035550176',false);
  IF r->>'code' IS DISTINCT FROM 'contact_change_requires_card_review' OR (SELECT claimed_at FROM public.party_link_claims WHERE id=cid) IS NOT NULL THEN
    RAISE EXCEPTION 'protected Party initial claim bypassed review'; END IF;
  INSERT INTO qa_r09_crm_checks VALUES('protected Party initial claim also requires card review',true);
END;$test$;
SELECT * FROM qa_r09_crm_checks;
ROLLBACK;
