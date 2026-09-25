-- QA only. No provider calls; synthetic rows and receipts roll back together.
BEGIN;
CREATE TEMP TABLE qa_card_retry_results(scenario text, passed boolean) ON COMMIT DROP;
DO $qa$
DECLARE s uuid:=gen_random_uuid(); sv uuid:=gen_random_uuid(); st uuid:=gen_random_uuid();
  b uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid(); r jsonb; replay jsonb;
  fp text:=encode(extensions.digest('card-retry-qa@example.invalid','sha256'),'hex');
BEGIN
  INSERT INTO auth.users(id,email) VALUES(actor,'card-retry-'||actor||'@example.invalid');
  INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('qa-card-'||s,'Synthetic','Synthetic');
  INSERT INTO public.salons(id,slug,name,phone,timezone,profile_complete,noshow_protection_enabled,email_links_enabled)
    VALUES(s,'e2e-card-retry-'||s,'E2E Card Retry Receipt','','America/Vancouver',true,true,true);
  INSERT INTO public.salon_members(salon_id,user_id,role) VALUES(s,actor,'owner');
  INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
    VALUES(sv,s,'Synthetic Service',5000,30,'qa-card-'||s);
  INSERT INTO public.staff(id,salon_id,name,status) VALUES(st,s,'Synthetic Staff','active');
  INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
    start_time_utc,end_time_utc,status,price_cents,noshow_card_required,noshow_fee_cents)
    VALUES(b,s,sv,st,'Synthetic Card Receipt','','card-retry-qa@example.invalid',
      now()+interval '10 days',now()+interval '10 days 30 minutes','confirmed',5000,true,1000);
  EXECUTE 'SET LOCAL ROLE service_role';
  r:=public.claim_card_retry_email(s,b,gen_random_uuid(),fp);
  IF r->>'state' IS DISTINCT FROM 'forbidden' THEN RAISE EXCEPTION 'actor isolation failed'; END IF;
  r:=public.claim_card_retry_email(s,b,actor,repeat('b',64));
  IF r->>'state' IS DISTINCT FROM 'invalid_booking' THEN RAISE EXCEPTION 'recipient binding failed'; END IF;
  r:=public.claim_card_retry_email(s,b,actor,fp);
  IF r->>'state' IS DISTINCT FROM 'claimed' THEN RAISE EXCEPTION 'first claim failed: %',r->>'state'; END IF;
  replay:=public.claim_card_retry_email(s,b,actor,fp);
  IF replay->>'state' IS DISTINCT FROM 'blocked' THEN RAISE EXCEPTION 'replay failed'; END IF;
  IF public.complete_card_retry_email(s,(r->>'id')::uuid,gen_random_uuid(),'synthetic-provider-id') THEN RAISE EXCEPTION 'stale attempt accepted'; END IF;
  IF NOT public.complete_card_retry_email(s,(r->>'id')::uuid,(r->>'attempt_id')::uuid,'synthetic-provider-id') THEN RAISE EXCEPTION 'completion failed'; END IF;
  replay:=public.claim_card_retry_email(s,b,actor,fp);
  IF replay->>'state' IS DISTINCT FROM 'already_accepted' THEN RAISE EXCEPTION 'accepted replay failed'; END IF;
  IF public.complete_card_retry_email(s,(r->>'id')::uuid,(r->>'attempt_id')::uuid,NULL) THEN RAISE EXCEPTION 'accepted receipt changed'; END IF;
  IF (SELECT count(*) FROM public.booking_card_retry_email_receipts WHERE salon_id=s)<>1 THEN RAISE EXCEPTION 'duplicate receipt'; END IF;
  EXECUTE 'RESET ROLE';
  INSERT INTO qa_card_retry_results VALUES('full_schema_service_role_claim_replay_completion_actor_recipient_fencing',true);
END $qa$;
SELECT * FROM qa_card_retry_results;
ROLLBACK;
