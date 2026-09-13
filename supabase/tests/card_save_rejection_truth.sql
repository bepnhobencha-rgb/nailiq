-- QA/disposable database only. Synthetic fixtures and all changes roll back.
-- Execute with the internal migration/test role; never against Production.
begin;
create temporary table qa_card_http_results (scenario text, passed boolean) on commit drop;
do $qa$
declare s uuid:=extensions.gen_random_uuid(); st uuid:=extensions.gen_random_uuid(); sv uuid:=extensions.gen_random_uuid();
 b uuid; req uuid; cap jsonb; op jsonb; r jsonb; replay jsonb; c jsonb; idx integer:=0;
 consent jsonb:=jsonb_build_object('policyVersion','nsp_'||repeat('a',64),'scope','booking_member','policyEn','Synthetic policy','policyVi','Chinh sach QA','feeCents',1000,'currency','CAD');
 cases jsonb:='[
 {"name":"definitive_card","stage":"card_create","code":"square_card_create_failed","retry":"new_card","http":400,"outcome":"failed","bind":true,"event":true,"expect":true},
 {"name":"non_rejection_code","stage":"card_create","code":"square_card_create_failed","retry":"new_card","http":400,"outcome":"failed","bind":true,"event":true,"expect":false},
 {"name":"empty_error_codes","stage":"card_create","code":"square_card_create_failed","retry":"new_card","http":400,"outcome":"failed","bind":true,"event":true,"expect":false},
 {"name":"missing_event","stage":"card_create","code":"square_card_create_failed","retry":"new_card","http":400,"outcome":"failed","bind":true,"event":false,"expect":false},
 {"name":"configuration","stage":"configuration","code":"square_config_unavailable","retry":"safe_retry","http":null,"outcome":"failed","bind":false,"event":true,"expect":false},
 {"name":"provider_timeout","stage":"card_create","code":"provider_response_lost","retry":"reconcile_first","http":null,"outcome":"unknown","bind":true,"event":true,"expect":false},
 {"name":"rate_limit","stage":"card_create","code":"square_card_create_failed","retry":"new_card","http":429,"outcome":"failed","bind":true,"event":true,"expect":false},
 {"name":"unsafe_reclassification","stage":"card_create","code":"square_card_create_failed","retry":"safe_retry","http":400,"outcome":"failed","bind":true,"event":true,"expect":false},
 {"name":"not_card_stage","stage":"customer_create","code":"square_customer_create_failed","retry":"new_card","http":400,"outcome":"failed","bind":true,"event":true,"expect":false},
 {"name":"unbound","stage":"card_create","code":"square_card_create_failed","retry":"new_card","http":400,"outcome":"failed","bind":false,"event":true,"expect":false}
 ]';
begin
 insert into public.service_categories(slug,name_en,name_vi) values('qa-http-'||s,'QA HTTP','QA HTTP');
 insert into public.salons(id,slug,name,phone,timezone,currency_code,profile_complete,noshow_protection_enabled,cancellation_policy)
 values(s,'qa-http-'||s,'Synthetic HTTP Truth','','America/Vancouver','CAD',true,true,'{"en":"Synthetic policy","vi":"Chinh sach QA"}');
 insert into public.services(id,salon_id,name,price_cents,duration_minutes,category) values(sv,s,'Synthetic Service',5000,30,'qa-http-'||s);
 insert into public.staff(id,salon_id,name,status) values(st,s,'Synthetic Staff','active');
 for c in select value from jsonb_array_elements(cases) loop
  idx:=idx+1; b:=extensions.gen_random_uuid(); req:=extensions.gen_random_uuid();
  insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,client_email,start_time_utc,end_time_utc,status,price_cents,noshow_card_required,noshow_fee_cents)
  values(b,s,sv,st,'Synthetic HTTP','','synthetic-'||b||'@example.com',now()+interval '10 days'+idx*interval '2 hours',now()+interval '10 days'+idx*interval '2 hours'+interval '30 minutes','confirmed',5000,true,1000);
  cap:=public.mint_booking_management_capability(s,b,'card_manage',now()+interval '25 minutes');
  op:=public.claim_booking_card_save_operation((cap->>'token_id')::uuid,req,'square','save_card',repeat('a',64));
  if op->>'code' is distinct from 'claimed' then raise exception 'claim failed %',c->>'name'; end if;
  r:=public.prepare_booking_card_save_dispatch((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,now(),consent);
  if r->>'ok' is distinct from 'true' then raise exception 'prepare failed %',c->>'name'; end if;
  if (c->>'bind')::boolean then
   r:=public.bind_booking_card_save_dispatch((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,'qa_customer','qa_merchant','sandbox');
   if r->>'ok' is distinct from 'true' then raise exception 'bind failed'; end if;
  end if;
  if (c->>'event')::boolean then
   r:=public.record_booking_card_delivery_failure((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,c->>'stage',c->>'code',(c->>'http')::integer,case when c->>'name'='empty_error_codes' then array[]::text[] when c->>'name'='non_rejection_code' then array['INTERNAL_SERVER_ERROR'] else array['INVALID_CARD_DATA'] end,array['INVALID_REQUEST_ERROR'],c->>'retry');
   if r->>'ok' is distinct from 'true' then raise exception 'event failed %',c->>'name'; end if;
  end if;
  r:=public.complete_booking_card_save_operation((op->>'operation_id')::uuid,extensions.gen_random_uuid(),c->>'outcome',null,null,null,null,null,null,null,c->>'code');
  if r->>'failure_kind'='card_rejected' then raise exception 'stale lease incorrectly classified'; end if;
  r:=public.complete_booking_card_save_operation((op->>'operation_id')::uuid,(op->>'attempt_token')::uuid,c->>'outcome',null,null,null,null,null,null,null,c->>'code');
  if coalesce(r->>'failure_kind'='card_rejected',false)<>(c->>'expect')::boolean then raise exception 'classification mismatch % code %',c->>'name',r->>'code'; end if;
  if exists(select 1 from public.bookings where id=b and (status<>'confirmed' or noshow_card_id is not null or card_protection_status='saved')) then raise exception 'unprotected booking mismatch'; end if;
  if (c->>'outcome')='failed' then
   replay:=public.claim_booking_card_save_operation((cap->>'token_id')::uuid,req,'square','save_card',repeat('a',64));
   if replay->>'idempotent' is distinct from 'true' or replay->>'code' is distinct from r->>'code' or replay->>'failure_kind' is distinct from r->>'failure_kind' then raise exception 'replay mismatch % code %',c->>'name',replay->>'code'; end if;
   if (select count(*) from public.booking_card_save_operations where booking_id=b)<>1 then raise exception 'duplicate operation'; end if;
  end if;
  insert into qa_card_http_results values(c->>'name',true);
 end loop;
end $qa$;
select * from qa_card_http_results;
rollback;
