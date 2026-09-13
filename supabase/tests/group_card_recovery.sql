-- Run against disposable QA only after creating a canonical two-member group.
-- Set test.group_card_recovery_booking_id and test.group_card_recovery_salon_id in this session.
-- All test mutations roll back. No provider calls.
begin;
do $test$
declare b public.bookings%rowtype; r jsonb; a jsonb; member_id uuid; snapshot jsonb; f jsonb; n integer;
begin
 select * into strict b from public.bookings where id=current_setting('test.group_card_recovery_booking_id')::uuid and salon_id=current_setting('test.group_card_recovery_salon_id')::uuid;
 member_id:=(b.public_booking_pricing_snapshot->'booking_ids'->>1)::uuid;
 snapshot:=b.public_booking_pricing_snapshot;
 if not exists(select 1 from salons where id=b.salon_id and slug like 'e2e-%') then raise exception 'Disposable QA fixture required'; end if;
 select count(*) into n from booking_management_capabilities where booking_id=b.id;
 if n<>0 then raise exception 'Use fresh canonical fixture with no capability'; end if;
 a:=public.exchange_public_booking_card_management_capability(b.salon_id,b.id,b.idempotency_key,b.public_booking_pricing_fingerprint);
 if a->>'ok' is distinct from 'true' or a->>'scope_kind' is distinct from 'organizer_own' then raise exception 'FAIL organizer receipt'; end if;
 r:=public.exchange_public_booking_card_management_capability(b.salon_id,b.id,b.idempotency_key,b.public_booking_pricing_fingerprint);
 if r->>'token_id' is distinct from a->>'token_id' or (select count(*) from booking_management_capabilities where booking_id=b.id)<>n+1 then raise exception 'FAIL duplicate'; end if;
 r:=public.exchange_public_booking_card_management_capability(b.salon_id,member_id,b.idempotency_key,b.public_booking_pricing_fingerprint);
 if r->>'code' is distinct from 'create_binding_invalid' then raise exception 'FAIL member'; end if;
 r:=public.exchange_public_booking_card_management_capability('11111111-1111-4111-8111-111111111111',b.id,b.idempotency_key,b.public_booking_pricing_fingerprint);
 if r->>'code' is distinct from 'create_binding_invalid' then raise exception 'FAIL tenant'; end if;
 r:=public.exchange_public_booking_card_management_capability(b.salon_id,b.id,'11111111-1111-4111-8111-111111111111',b.public_booking_pricing_fingerprint);
 if r->>'code' is distinct from 'create_binding_invalid' then raise exception 'FAIL key'; end if;
 r:=public.exchange_public_booking_card_management_capability(b.salon_id,b.id,b.idempotency_key,repeat('0',64));
 if r->>'code' is distinct from 'create_binding_invalid' then raise exception 'FAIL price'; end if;
 for f in select value from jsonb_array_elements(jsonb_build_array(
   snapshot-'group_id',
   jsonb_set(snapshot,'{booking_ids}','{}'),
   jsonb_set(snapshot,'{booking_ids}',jsonb_build_array(member_id,b.id)),
   jsonb_set(snapshot,'{booking_ids}',jsonb_build_array(b.id,b.id)),
   jsonb_set(snapshot,'{booking_ids}',jsonb_build_array(b.id,'11111111-1111-4111-8111-111111111111'))
 )) loop
   update bookings set public_booking_pricing_snapshot=f where id=b.id;
   r:=public.exchange_public_booking_card_management_capability(b.salon_id,b.id,b.idempotency_key,b.public_booking_pricing_fingerprint);
   if r->>'code' is distinct from 'create_binding_invalid' then raise exception 'FAIL malformed group receipt'; end if;
 end loop;
 update bookings set public_booking_pricing_snapshot=snapshot,created_at=clock_timestamp()-interval '31 minutes' where id=b.id;
 r:=public.exchange_public_booking_card_management_capability(b.salon_id,b.id,b.idempotency_key,b.public_booking_pricing_fingerprint);
 if r->>'code' is distinct from 'exchange_expired' then raise exception 'FAIL original expiry'; end if;
 update bookings set created_at=b.created_at,deleted_at=clock_timestamp() where id=b.id;
 r:=public.exchange_public_booking_card_management_capability(b.salon_id,b.id,b.idempotency_key,b.public_booking_pricing_fingerprint);
 if r->>'code' is distinct from 'create_binding_invalid' then raise exception 'FAIL closed booking'; end if;
 if exists(select 1 from booking_card_save_operations where salon_id=b.salon_id) then raise exception 'FAIL provider operation'; end if;
 if has_function_privilege('anon','public.exchange_public_booking_card_management_capability(uuid,uuid,uuid,text)','execute') or has_function_privilege('authenticated','public.exchange_public_booking_card_management_capability(uuid,uuid,uuid,text)','execute') then raise exception 'FAIL service only'; end if;
end $test$;
rollback;
