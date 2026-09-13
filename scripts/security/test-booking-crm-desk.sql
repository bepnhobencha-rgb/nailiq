-- Offline disposable QA only. Actor/tenant and exactly-once CRM acceptance.
-- All synthetic writes roll back. Notification choices are explicitly false.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('request.jwt.claim.role','service_role',true);
CREATE TEMP TABLE qa_r09_desk_checks(scenario text,passed boolean) ON COMMIT DROP;
DO $test$
DECLARE
  s uuid:=extensions.gen_random_uuid(); s2 uuid:=extensions.gen_random_uuid();
  sv uuid:=extensions.gen_random_uuid(); st uuid:=extensions.gen_random_uuid(); st2 uuid:=extensions.gen_random_uuid();
  actor uuid:=extensions.gen_random_uuid(); foreign_actor uuid:=extensions.gen_random_uuid();
  req uuid:=extensions.gen_random_uuid(); group_req uuid:=extensions.gen_random_uuid();
  b uuid; cp uuid; g uuid; lid uuid:=extensions.gen_random_uuid(); cid uuid:=extensions.gen_random_uuid();
  token text:='synthetic-r09-desk-'||extensions.gen_random_uuid();
  t timestamptz:=date_trunc('day',now()+interval '8 days')+interval '10 hours';
  q jsonb; r jsonb; payload jsonb; ids uuid[]; count_before integer;
  hours jsonb:='{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}';
BEGIN
  INSERT INTO auth.users(id,email,created_at) VALUES(actor,'synthetic-desk-'||actor||'@example.test',now()),(foreign_actor,'synthetic-desk-'||foreign_actor||'@example.test',now());
  INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('qa-r09-desk-'||s,'Synthetic Desk','Synthetic Desk');
  INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete,subscription_plan,subscription_status,is_beta,resources_enabled,opening_hours,feature_flags,tax_lines)
  VALUES(s,'disposable-r09-desk-'||s,'Synthetic Desk','','UTC','CAD',true,'premium','active',true,false,hours,'{"group_booking_enabled":true}','[]'),
    (s2,'disposable-r09-desk-'||s2,'Synthetic Other Desk','','UTC','CAD',true,'premium','active',true,false,hours,'{}','[]');
  INSERT INTO public.salon_members(salon_id,user_id,role) VALUES(s,actor,'owner'),(s2,foreign_actor,'owner');
  INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,buffer_minutes,category)
  VALUES(sv,s,'Synthetic Desk Service',2000,30,0,'qa-r09-desk-'||s);
  INSERT INTO public.staff(id,salon_id,name,status) VALUES(st,s,'Synthetic Desk Staff','active'),(st2,s,'Synthetic Desk Staff Two','active');
  q:=public.quote_public_booking(s,sv,st,t,t+interval '30 minutes',ARRAY[]::uuid[],NULL,NULL,'17035550170','synthetic-desk@example.test',false);
  IF q->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'desk fixture quote: %',q->>'code'; END IF;
  r:=public.create_public_booking_for_desk_with_staff_notification(s,sv,st,'Synthetic Desk Client','17035550170',t,t+interval '30 minutes',
    'confirmed',NULL,ARRAY[]::uuid[],'synthetic-desk@example.test',NULL,NULL,NULL,false,req,q->>'pricing_fingerprint',foreign_actor,false,false,5);
  IF r->>'code' IS DISTINCT FROM 'actor_unauthorized' OR EXISTS(SELECT 1 FROM public.bookings WHERE salon_id=s) THEN
    RAISE EXCEPTION 'foreign single desk actor mutated'; END IF;
  r:=public.create_public_booking_for_desk_with_staff_notification(s,sv,st,'Synthetic Desk Client','17035550170',t,t+interval '30 minutes',
    'confirmed',NULL,ARRAY[]::uuid[],'synthetic-desk@example.test',NULL,NULL,NULL,false,req,q->>'pricing_fingerprint',actor,false,false,5);
  b:=(r->>'booking_id')::uuid;
  SELECT client_profile_id INTO cp FROM public.bookings WHERE id=b;
  IF r->>'success' IS DISTINCT FROM 'true' OR cp IS NULL OR NOT EXISTS(SELECT 1 FROM public.client_profiles WHERE id=cp AND visit_count=1)
    OR EXISTS(SELECT 1 FROM public.staff_action_notification_outbox WHERE salon_id=s) THEN RAISE EXCEPTION 'desk single CRM/notification boundary'; END IF;
  r:=public.create_public_booking_for_desk_with_staff_notification(s,sv,st,'Synthetic Desk Client','17035550170',t,t+interval '30 minutes',
    'confirmed',NULL,ARRAY[]::uuid[],'synthetic-desk@example.test',NULL,NULL,NULL,false,req,q->>'pricing_fingerprint',actor,false,false,5);
  IF r->>'idempotent' IS DISTINCT FROM 'true' OR (SELECT visit_count FROM public.client_profiles WHERE id=cp)<>1 THEN RAISE EXCEPTION 'desk single replay duplicated CRM'; END IF;
  INSERT INTO qa_r09_desk_checks VALUES('single desk validates tenant actor and links once with notifications false',true);

  t:=t+interval '1 day';
  payload:=jsonb_build_array(
    jsonb_build_object('service_id',sv,'staff_id',st,'start_time_utc',t,'end_time_utc',t+interval '30 minutes','client_name','Synthetic Desk Organizer','client_phone','17035550171','addon_service_ids','[]'::jsonb),
    jsonb_build_object('service_id',sv,'staff_id',st2,'start_time_utc',t,'end_time_utc',t+interval '30 minutes','client_name','Synthetic Desk Guest','client_phone','17035550172','addon_service_ids','[]'::jsonb));
  q:=public.quote_group_booking(s,payload,NULL,'17035550171',NULL,false);
  IF q->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'desk group fixture quote: %',q->>'code'; END IF;
  r:=public.create_group_bookings_for_desk(s,payload,NULL,'17035550171',NULL,false,group_req,q->>'pricing_fingerprint',foreign_actor);
  IF r->>'code' IS DISTINCT FROM 'actor_unauthorized' THEN RAISE EXCEPTION 'foreign group actor accepted'; END IF;
  r:=public.create_group_bookings_for_desk(s,payload,NULL,'17035550171',NULL,false,group_req,q->>'pricing_fingerprint',actor);
  IF r->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'desk group failed: %',r->>'code'; END IF;
  SELECT array_agg(value::uuid) INTO ids FROM jsonb_array_elements_text(r->'booking_ids');
  IF (SELECT count(*) FROM public.bookings b JOIN public.client_profiles p ON p.id=b.client_profile_id
      WHERE b.id=ANY(ids) AND p.phone=public.canonical_phone(b.client_phone) AND p.visit_count=1)<>2 THEN RAISE EXCEPTION 'desk group missing authorized guest CRM'; END IF;
  r:=public.create_group_bookings_for_desk(s,payload,NULL,'17035550171',NULL,false,group_req,q->>'pricing_fingerprint',actor);
  IF r->>'idempotent' IS DISTINCT FROM 'true' OR EXISTS(SELECT 1 FROM public.client_profiles p JOIN public.bookings b ON b.client_profile_id=p.id
    WHERE b.id=ANY(ids) AND p.visit_count<>1) THEN RAISE EXCEPTION 'desk group replay duplicated CRM'; END IF;
  INSERT INTO qa_r09_desk_checks VALUES('group desk validates tenant actor and links organizer/guest exactly once',true);

  SELECT count(*) INTO count_before FROM public.bookings WHERE salon_id=s;
  PERFORM set_config('request.jwt.claim.role','anon',true);
  r:=public.create_group_bookings_for_desk(s,payload,NULL,'17035550171',NULL,false,extensions.gen_random_uuid(),q->>'pricing_fingerprint',actor);
  IF r->>'code' IS DISTINCT FROM 'actor_unauthorized' OR (SELECT count(*) FROM public.bookings WHERE salon_id=s)<>count_before THEN
    RAISE EXCEPTION 'actor UUID bypassed service boundary'; END IF;
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  INSERT INTO qa_r09_desk_checks VALUES('actor UUID alone cannot elevate anonymous group caller',true);

  g:=extensions.gen_random_uuid();
  INSERT INTO public.bookings(salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents,group_id,group_size,is_party_member)
  VALUES(s,sv,st,'Synthetic Unclaimed Desk',NULL,t+interval '1 day',t+interval '1 day 30 minutes','confirmed',2000,g,2,true) RETURNING id INTO b;
  INSERT INTO public.party_links(id,group_id,salon_id,token,expires_at) VALUES(lid,g,s,token,now()+interval '1 day');
  INSERT INTO public.party_link_claims(id,party_link_id,booking_id) VALUES(cid,lid,b);
  r:=public.claim_party_slot_for_desk(token,cid,'Synthetic Desk Claim','17035550173',false,s,foreign_actor);
  IF r->>'code' IS DISTINCT FROM 'actor_unauthorized' OR (SELECT claimed_at FROM public.party_link_claims WHERE id=cid) IS NOT NULL THEN
    RAISE EXCEPTION 'foreign desk Party actor accepted'; END IF;
  r:=public.claim_party_slot_for_desk(token,cid,'Synthetic Desk Claim','17035550173',false,s,actor);
  IF r->>'success' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.bookings bk JOIN public.client_profiles p ON p.id=bk.client_profile_id
    WHERE bk.id=b AND bk.salon_id=s AND p.phone='17035550173' AND p.visit_count=1) THEN RAISE EXCEPTION 'desk Party CRM not attached'; END IF;
  INSERT INTO qa_r09_desk_checks VALUES('Party desk actor retains CRM authority independently from public claim',true);
END;$test$;
SELECT * FROM qa_r09_desk_checks;
ROLLBACK;
