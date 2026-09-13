-- Disposable QA only. Runner supplies qa.retirement_salon. All rows are rolled back.
begin;
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare
 s uuid := current_setting('qa.retirement_salon')::uuid;
 staff_one uuid; staff_two uuid; service_one uuid;
 k uuid; q jsonb; payload jsonb; result jsonb; baseline integer; segments_before integer;
begin
 if not exists(select 1 from salons where id=s and slug like 'e2e-p003-retry-%' and profile_complete and is_beta) then raise exception 'QA fixture only'; end if;
 select id into staff_one from staff where salon_id=s and name='Jenny';
 select id into staff_two from staff where salon_id=s and name='QA Anna';
 select id into service_one from services where salon_id=s and name='Gel Manicure';
 select count(*) into baseline from bookings where salon_id=s;
 select count(*) into segments_before from booking_service_segments where salon_id=s;
 k:=gen_random_uuid();
 payload:=jsonb_build_object('contract_version',1,'salon_id',s,'request_id',k,'requested_start_time_utc','2026-09-18T19:00:00Z','same_staff_for_all',false,'voucher_code',null,'apply_email_discount',false,'customer',jsonb_build_object('name','E2E Retired SQL','phone','+16045550196','email',null),'lines',jsonb_build_array(jsonb_build_object('line_id',gen_random_uuid(),'position',0,'service_id',service_one,'staff_preference',staff_one,'preferred_resource_id',null,'addon_service_ids','[]'::jsonb,'timing_preference','sequential')));
 q:=quote_public_booking_sequence(payload);
 if q->>'success'<>'true' or q->>'pricing_fingerprint' is null then raise exception 'FAIL sequence quote: %',q->>'code'; end if;
 result:=resolve_pending_booking_create(s,k,'sequence',q->>'pricing_fingerprint');
 if result->>'status'<>'retired' then raise exception 'FAIL sequence retirement'; end if;
 begin
  result:=create_public_booking_sequence(payload||jsonb_build_object('expected_pricing_fingerprint',q->>'pricing_fingerprint','health_acknowledged',false,'sms_consent',false,'notification_language','vi'));
  raise exception 'FAIL sequence accepted retired request: %',result->>'code';
 exception when sqlstate 'P0001' then
  if sqlerrm<>'booking_create_request_retired' then raise; end if;
 end;
 if (select count(*) from bookings where salon_id=s)<>baseline or (select count(*) from booking_service_segments where salon_id=s)<>segments_before then raise exception 'FAIL partial sequence'; end if;

 k:=gen_random_uuid();
 payload:=jsonb_build_array(
 jsonb_build_object('service_id',service_one,'staff_id',staff_one,'start_time_utc','2026-09-21T19:00:00Z','end_time_utc','2026-09-21T19:55:00Z','addon_service_ids','[]'::jsonb,'client_name','E2E Retired Group One','client_phone','+16045550197','staff_requested_by_client',true,'wave_number',1,'seat_together',true,'client_locale','vi'),
 jsonb_build_object('service_id',service_one,'staff_id',staff_two,'start_time_utc','2026-09-21T19:00:00Z','end_time_utc','2026-09-21T19:55:00Z','addon_service_ids','[]'::jsonb,'client_name','E2E Retired Group Two','client_phone',null,'staff_requested_by_client',true,'wave_number',1,'seat_together',true,'client_locale','vi'));
 q:=quote_group_booking(s,payload,null,'+16045550197',null,false);
 if q->>'success'<>'true' or q->>'pricing_fingerprint' is null then raise exception 'FAIL group quote: %',q->>'code'; end if;
 result:=resolve_pending_booking_create(s,k,'group',q->>'pricing_fingerprint');
 if result->>'status'<>'retired' then raise exception 'FAIL group retirement'; end if;
 begin
  result:=create_group_bookings(s,payload,null,'+16045550197',null,false,k,q->>'pricing_fingerprint');
  raise exception 'FAIL group accepted retired request: %',result->>'code';
 exception when sqlstate 'P0001' then
  if sqlerrm<>'booking_create_request_retired' then raise; end if;
 end;
 if (select count(*) from bookings where salon_id=s)<>baseline then raise exception 'FAIL partial group'; end if;
end $$;
select 'PASS actual sequence and group retired-key create, no partial writes' as result;
rollback;
