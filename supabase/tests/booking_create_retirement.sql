-- QA-only fixture supplied by the runner. Entire test rolls back its synthetic rows.
begin;
select set_config('request.jwt.claim.role','service_role',true);
do $test$
declare
 s uuid := current_setting('qa.retirement_salon')::uuid;
 svc uuid; st uuid; k uuid; b uuid; result jsonb; n integer; q jsonb; receipt jsonb;
 t timestamptz := '2026-09-15 16:00:00+00';
begin
 if not exists(select 1 from salons where id=s and slug like 'e2e-p003-retire-%') then raise exception 'QA fixture only'; end if;
 select id into strict svc from services where salon_id=s order by created_at limit 1;
 select id into strict st from staff where salon_id=s order by created_at limit 1;
 k:=gen_random_uuid();
 result:=resolve_pending_booking_create(s,k,'individual',repeat('a',64));
 if result->>'status'<>'retired' then raise exception 'FAIL zero result retirement'; end if;
 if resolve_pending_booking_create(s,k,'individual',repeat('a',64))<>result then raise exception 'FAIL idempotent replay'; end if;
 if resolve_pending_booking_create(s,k,'sequence',repeat('a',64))->>'status'<>'unavailable' then raise exception 'FAIL wrong kind'; end if;
 if resolve_pending_booking_create(s,k,'individual',repeat('b',64))->>'status'<>'unavailable' then raise exception 'FAIL wrong fingerprint'; end if;
 if resolve_pending_booking_create(gen_random_uuid(),k,'individual',repeat('a',64))->>'status'<>'unavailable' then raise exception 'FAIL foreign tenant'; end if;
 begin
  insert into bookings(salon_id,service_id,staff_id,start_time_utc,end_time_utc,status,client_name,client_phone,idempotency_key) values(s,svc,st,t,t+interval '45 minutes','confirmed','Synthetic Fence','16045550196',k);
  raise exception 'FAIL retired key inserted';
 exception when sqlstate 'P0001' then
  if sqlerrm<>'booking_create_request_retired' then raise; end if;
 end;
 -- The ordinary engine attaches its key after inserting. Both statements must roll back.
 begin
  insert into bookings(salon_id,service_id,staff_id,start_time_utc,end_time_utc,status,client_name,client_phone) values(s,svc,st,t,t+interval '45 minutes','confirmed','Synthetic Fence','16045550196') returning id into b;
  update bookings set idempotency_key=k where id=b;
  raise exception 'FAIL late key attached';
 exception when sqlstate 'P0001' then
  if sqlerrm<>'booking_create_request_retired' then raise; end if;
 end;
 if exists(select 1 from bookings where id=b) then raise exception 'FAIL partial booking survived'; end if;
 k:=gen_random_uuid();
 insert into bookings(salon_id,service_id,staff_id,start_time_utc,end_time_utc,status,client_name,client_phone,idempotency_key,public_booking_pricing_fingerprint,public_booking_pricing_snapshot)
 values(s,svc,st,t,t+interval '45 minutes','confirmed','Synthetic Exists','16045550196',k,repeat('a',64),jsonb_build_object('pricing_fingerprint',repeat('a',64))) returning id into b;
 if resolve_pending_booking_create(s,k,'individual',repeat('a',64))->>'status'<>'booking_exists' then raise exception 'FAIL existing booking lost'; end if;
 if exists(select 1 from retired_booking_create_requests where salon_id=s and request_id=k) then raise exception 'FAIL existing booking retired'; end if;
 update bookings set status='cancelled' where id=b;
 if resolve_pending_booking_create(s,k,'individual',repeat('a',64))->>'status'<>'booking_exists' then raise exception 'FAIL inactive existence truth'; end if;
 if (select status from bookings where id=b)<>'cancelled' then raise exception 'FAIL booking mutated'; end if;
 -- Exercise the actual ordinary create RPC, including legacy insert + metadata completion.
 t:='2026-09-16 16:00:00+00'; k:=gen_random_uuid();
 q:=resolve_public_booking_pricing(s,svc,st,t,t+interval '55 minutes',array[]::uuid[],null,null,'16045550196',null,false,true);
 if q->>'success'<>'true' then raise exception 'FAIL fixture quote %',q->>'code'; end if;
 if resolve_pending_booking_create(s,k,'individual',q->>'pricing_fingerprint')->>'status'<>'retired' then raise exception 'FAIL canonical retirement'; end if;
 select count(*) into n from bookings where salon_id=s;
 begin
  receipt:=create_public_booking(s,svc,st,'Synthetic Late','16045550196',t,t+interval '55 minutes','confirmed',null,array[]::uuid[],null,null,null,null,false,k,q->>'pricing_fingerprint');
  raise exception 'FAIL real RPC accepted retired request';
 exception when sqlstate 'P0001' then
  if sqlerrm<>'booking_create_request_retired' then raise; end if;
 end;
 if (select count(*) from bookings where salon_id=s)<>n then raise exception 'FAIL real RPC left partial booking'; end if;
 if has_table_privilege('anon','public.retired_booking_create_requests','select') or has_table_privilege('authenticated','public.retired_booking_create_requests','select') then raise exception 'FAIL ledger exposed'; end if;
 if has_function_privilege('anon','public.resolve_pending_booking_create(uuid,uuid,text,text)','execute') or has_function_privilege('authenticated','public.resolve_pending_booking_create(uuid,uuid,text,text)','execute') then raise exception 'FAIL RPC exposed'; end if;
 perform set_config('request.jwt.claim.role','anon',true);
 if resolve_pending_booking_create(s,gen_random_uuid(),'individual',repeat('a',64))->>'status'<>'unavailable' then raise exception 'FAIL caller role'; end if;
end $test$;
rollback;
