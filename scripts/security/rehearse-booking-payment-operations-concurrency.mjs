#!/usr/bin/env node
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const run=promisify(execFile);
const dbUrl=process.env.DB_URL,psql=process.env.PSQL_BIN??"psql";
if(process.env.NAILIQ_DISPOSABLE_DB!=="1"||!dbUrl) throw new Error("disposable local DB required");
const host=new URL(dbUrl).hostname;
if(!["localhost","127.0.0.1","::1","[::1]",""].includes(host)) throw new Error(`non-local host ${host}`);
async function sql(q){const {stdout}=await run(psql,[dbUrl,"-X","-v","ON_ERROR_STOP=1","-Atq","-c",q],{encoding:"utf8",timeout:30000,maxBuffer:4e6});return stdout.trim();}
function json(s){const line=s.split("\n").filter((x)=>x.startsWith("{")).at(-1);return line?JSON.parse(line):null;}
const salon="15160000-0000-4000-8000-000000000001",service="15160000-0000-4000-8000-000000000002",staff="15160000-0000-4000-8000-000000000003";
const noshow="15160000-0000-4000-8000-000000000010",late="15160000-0000-4000-8000-000000000020";
async function cleanup(){await sql(`select pg_catalog.set_config('request.jwt.claim.role','service_role',false); delete from public.booking_cancel_deposit_refund_sagas where salon_id='${salon}'; delete from public.booking_payment_operations where salon_id='${salon}'; delete from public.booking_management_capabilities where salon_id='${salon}'; delete from public.booking_management_action_state where salon_id='${salon}'; delete from public.bookings where salon_id='${salon}'; delete from public.client_profiles where phone in ('16045551603','16045551604'); delete from public.square_integrations where salon_id='${salon}'; delete from public.staff where salon_id='${salon}'; delete from public.services where salon_id='${salon}'; delete from public.salons where id='${salon}'; delete from public.service_categories where slug='payment-concurrency-qa';`);}
try{
 await cleanup();
 await sql(`insert into public.service_categories(slug,name_en,name_vi) values('payment-concurrency-qa','Payment concurrency','Payment concurrency');
 insert into public.salons(id,slug,name,phone,timezone,currency_code,payment_provider,stripe_connect_account_id,stripe_connect_charges_enabled,self_cancel_fee_enabled,self_cancel_window_hours) values('${salon}','payment-concurrency-qa','Payment concurrency','+16045551600','UTC','CAD','stripe','acct_payment_concurrency',true,true,120);
 insert into public.services(id,salon_id,name,price_cents,duration_minutes,category) values('${service}','${salon}','Payment concurrency',5000,30,'payment-concurrency-qa');
 insert into public.staff(id,salon_id,name,status) values('${staff}','${salon}','Payment concurrency','active');
 update public.salons set opening_hours='{"sun":{"open":"00:00","close":"23:59","closed":false},"mon":{"open":"00:00","close":"23:59","closed":false},"tue":{"open":"00:00","close":"23:59","closed":false},"wed":{"open":"00:00","close":"23:59","closed":false},"thu":{"open":"00:00","close":"23:59","closed":false},"fri":{"open":"00:00","close":"23:59","closed":false},"sat":{"open":"00:00","close":"23:59","closed":false}}'::jsonb,deposit_high_value_cents=1,deposit_pct_new_customer=20 where id='${salon}';
 insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,noshow_card_id,noshow_customer_id,noshow_consent_at,noshow_fee_cents,noshow_charge_status) values
 ('${noshow}','${salon}','${service}','${staff}','No show','+16045551601',clock_timestamp()-interval '1 day',clock_timestamp()-interval '1 day'+interval '30 minutes','no_show','pm_noshow_concurrency','cus_noshow_concurrency',clock_timestamp(),1500,'saved');
 insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,noshow_card_id,noshow_customer_id,noshow_consent_at,noshow_charge_status,noshow_fee_cents) values
 ('${late}','${salon}','${service}','${staff}','Late cancel','+16045551602',clock_timestamp()+interval '3 days',clock_timestamp()+interval '3 days 30 minutes','confirmed','pm_late_concurrency','cus_late_concurrency',clock_timestamp(),'saved',1500);
 update public.bookings set status='cancelled' where id='${late}';
 insert into public.booking_management_action_state(salon_id,booking_id,action,epoch) values('${salon}','${late}','cancel',2);
 insert into public.booking_management_capabilities(id,salon_id,booking_id,action,scope_kind,epoch,booking_version,expires_at,consumed_at,revoke_reason,request_id,payload_fingerprint,result_json,result_fingerprint) values
 ('15160000-0000-4000-8000-000000000021','${salon}','${late}','cancel','booking_own',1,0,clock_timestamp()+interval '1 day',clock_timestamp(),'action_consumed',gen_random_uuid(),repeat('1',64),jsonb_build_object('ok',true,'status','cancelled','scope_kind','booking_own','rsvp_semantic',null,'customer_transition_version',1,'cancel_preview',jsonb_build_object('will_charge',true,'has_chargeable_card',true,'within_window',true,'fee_cents',1500,'currency','CAD')),repeat('2',64));`);

 const noMat=json(await sql(`begin;set local role service_role;select public.load_booking_payment_operation_material('${salon}','${noshow}','noshow_charge',1500)::text;commit;`));
 const noClaims=(await Promise.all(Array.from({length:10},(_,i)=>sql(`begin;set local role service_role;select public.claim_booking_payment_operation('${salon}','${noshow}',('15160000-0000-4000-8000-'||lpad('${100+i}',12,'0'))::uuid,'noshow_charge',1500,'${noMat.material_fingerprint}')::text;commit;`)))).map(json);
 assert.equal(new Set(noClaims.map((x)=>x.operation_id)).size,1,JSON.stringify(noClaims));
 assert.equal(noClaims.filter((x)=>x.code==="claimed").length,1);

 const lateMat=json(await sql(`begin;set local role service_role;select public.load_booking_payment_operation_material('${salon}','${late}','late_cancel_charge',1500)::text;commit;`));
 const lateClaims=(await Promise.all(Array.from({length:10},(_,i)=>sql(`begin;set local role service_role;select public.claim_booking_payment_operation('${salon}','${late}',('15160000-0000-4000-8000-'||lpad('${200+i}',12,'0'))::uuid,'late_cancel_charge',1500,'${lateMat.material_fingerprint}')::text;commit;`)))).map(json);
 assert.equal(new Set(lateClaims.map((x)=>x.operation_id)).size,1,JSON.stringify(lateClaims));
 assert.equal(lateClaims.filter((x)=>x.code==="claimed").length,1);
 const lateClaim=lateClaims.find((x)=>x.code==="claimed");
 const completed=json(await sql(`begin;set local role service_role;select public.complete_booking_payment_operation('${lateClaim.operation_id}','${lateClaim.attempt_token}','succeeded','succeeded','pi_late_concurrency',null,null)::text;commit;`));
 assert.equal(completed.code,"succeeded");

 const refundMat=json(await sql(`begin;set local role service_role;select public.load_late_cancel_refund_material('${lateClaim.operation_id}',900)::text;commit;`));
 const refundClaims=(await Promise.all([301,302].map((n)=>sql(`begin;set local role service_role;select public.claim_late_cancel_refund('${lateClaim.operation_id}',('15160000-0000-4000-8000-'||lpad('${n}',12,'0'))::uuid,900,'${refundMat.material_fingerprint}')::text;commit;`)))).map(json);
 assert.equal(refundClaims.filter((x)=>x.code==="claimed").length,1,JSON.stringify(refundClaims));
 assert.equal(refundClaims.filter((x)=>["material_changed","refund_amount_exceeds_remaining"].includes(x.code)).length,1,JSON.stringify(refundClaims));

 const parent="15160000-0000-4000-8000-000000000400",booking="15160000-0000-4000-8000-000000000401",intent="15160000-0000-4000-8000-000000000402";
 const start=new Date(Date.now()+4*86400e3).toISOString(),end=new Date(Date.now()+4*86400e3+1800e3).toISOString();
 const phone="+16045551603",phoneFp=await sql(`select encode(extensions.digest(convert_to(public.canonical_phone('${phone}'),'UTF8'),'sha256'),'hex')`);
 await sql(`insert into public.booking_payment_operations(id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,amount_cents,currency,material_fingerprint,material_json,provider_material,booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,start_time_utc,end_time_utc,client_phone_fingerprint,provider_payment_id,provider_idempotency_key,status,result_json,completed_at,binding_expires_at,unbound_compensation_due_at) values('${parent}','${salon}','15160000-0000-4000-8000-000000000403','deposit_charge','stripe',repeat('a',64),1000,'CAD',repeat('b',64),'{}','{}','${intent}',repeat('c',64),'${service}','${staff}','${start}','${end}','${phoneFp}','pi_bind_comp_concurrency','nq:${parent}','succeeded','{}',clock_timestamp(),clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '10 minutes');
 insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,idempotency_key,public_booking_pricing_fingerprint) values('${booking}','${salon}','${service}','${staff}','Bind race','${phone}','${start}','${end}','confirmed','${intent}',repeat('c',64));`);
 const compMat=json(await sql(`begin;set local role service_role;select public.load_unbound_deposit_refund_material('${parent}')::text;commit;`));
 const [bind,comp]=await Promise.all([
   sql(`begin;set local role service_role;select public.bind_public_deposit_payment_operation('${parent}','15160000-0000-4000-8000-000000000403',repeat('b',64),'${booking}')::text;commit;`),
   sql(`begin;set local role service_role;select public.claim_unbound_deposit_refund('${parent}','15160000-0000-4000-8000-000000000404','${compMat.material_fingerprint}')::text;commit;`)
 ]).then((xs)=>xs.map(json));
 assert.equal([bind,comp].filter((x)=>["bound","claimed"].includes(x.code)).length,1,JSON.stringify({bind,comp}));
 assert.equal([bind,comp].filter((x)=>["parent_payment_already_bound","deposit_compensation_already_claimed"].includes(x.code)).length,1,JSON.stringify({bind,comp}));

 const atomicOp="15160000-0000-4000-8000-000000000500",atomicRequest="15160000-0000-4000-8000-000000000501",atomicIntent="15160000-0000-4000-8000-000000000502";
 const atomicStart=new Date(Date.now()+6*86400e3).toISOString().replace(/\.\d{3}Z$/,"Z");
 const atomicEnd=new Date(Date.parse(atomicStart)+40*60e3).toISOString();
 const atomicPhone="+16045551604";
 const atomicQuote=json(await sql(`begin;set local role service_role;select set_config('request.jwt.claim.role','service_role',true);select public.quote_public_booking('${salon}','${service}','${staff}','${atomicStart}','${atomicEnd}',array[]::uuid[],null,null,'${atomicPhone}',null,false)::text;commit;`));
 assert.equal(atomicQuote.success,true,JSON.stringify(atomicQuote));
 const atomicRequestFp=await sql(`begin;set local role service_role;select public.public_deposit_request_fingerprint('${salon}','${service}','${staff}','${atomicStart}','${atomicEnd}',array[]::uuid[],null,null,'${atomicPhone}',null,false,'${atomicIntent}','${atomicQuote.pricing_fingerprint}');commit;`);
 const atomicPhoneFp=await sql(`select encode(extensions.digest(convert_to(public.canonical_phone('${atomicPhone}'),'UTF8'),'sha256'),'hex')`);
 await sql(`insert into public.booking_payment_operations(id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,amount_cents,currency,material_fingerprint,material_json,provider_material,public_request_fingerprint,booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,start_time_utc,end_time_utc,client_phone_fingerprint,provider_payment_id,provider_idempotency_key,status,result_json,completed_at,binding_expires_at,unbound_compensation_due_at) values('${atomicOp}','${salon}','${atomicRequest}','deposit_charge','stripe',repeat('a',64),1000,'CAD',repeat('e',64),jsonb_build_object('deposit_reason','qa'),jsonb_build_object('provider','stripe'),'${atomicRequestFp}','${atomicIntent}','${atomicQuote.pricing_fingerprint}','${service}','${staff}','${atomicStart}','${atomicEnd}','${atomicPhoneFp}','pi_atomic_create_comp_race','nq:${atomicOp}','succeeded','{}',clock_timestamp(),clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '10 minutes');`);
 const atomicCompMat=json(await sql(`begin;set local role service_role;select public.load_unbound_deposit_refund_material('${atomicOp}')::text;commit;`));
 const [atomicCreate,atomicComp]=await Promise.all([
   sql(`begin;set local role service_role;select set_config('request.jwt.claim.role','service_role',true);select public.create_public_booking_with_deposit_payment('${salon}','${service}','${staff}','Atomic race','${atomicPhone}','${atomicStart}','${atomicEnd}','confirmed',null,array[]::uuid[],null,null,null,null,false,'${atomicIntent}','${atomicQuote.pricing_fingerprint}','${atomicOp}','${atomicRequest}',repeat('e',64))::text;commit;`),
   sql(`begin;set local role service_role;select public.claim_unbound_deposit_refund('${atomicOp}','15160000-0000-4000-8000-000000000503','${atomicCompMat.material_fingerprint}')::text;commit;`)
 ]).then((xs)=>xs.map(json));
 assert.equal([atomicCreate,atomicComp].filter((x)=>["booked_and_deposit_bound","claimed"].includes(x.code)).length,1,JSON.stringify({atomicCreate,atomicComp}));
 assert.equal([atomicCreate,atomicComp].filter((x)=>["deposit_compensation_already_claimed","parent_payment_already_bound"].includes(x.code)).length,1,JSON.stringify({atomicCreate,atomicComp}));
 const atomicRows=Number(await sql(`select count(*) from public.bookings where salon_id='${salon}' and idempotency_key='${atomicIntent}'`));
 assert.equal(atomicRows,atomicCreate.code==="booked_and_deposit_bound"?1:0,JSON.stringify({atomicCreate,atomicComp,atomicRows}));

 const dueOp="15160000-0000-4000-8000-000000000600";
 await sql(`insert into public.booking_payment_operations(id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,amount_cents,currency,material_fingerprint,material_json,provider_material,booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,start_time_utc,end_time_utc,client_phone_fingerprint,provider_idempotency_key,status,attempt_token,lease_expires_at) values('${dueOp}','${salon}','15160000-0000-4000-8000-000000000601','deposit_charge','stripe',repeat('1',64),1000,'CAD',repeat('2',64),'{}',jsonb_build_object('route','exact'),'15160000-0000-4000-8000-000000000602',repeat('3',64),'${service}','${staff}',clock_timestamp()+interval '7 days',clock_timestamp()+interval '7 days 40 minutes',repeat('4',64),'nq:${dueOp}','sending',gen_random_uuid(),clock_timestamp()-interval '1 second');`);
 const dueClaims=(await Promise.all([1,2].map(()=>sql(`begin;set local role service_role;select x::text from public.discover_due_booking_payment_reconciliations(10) x;commit;`)))).map(json).filter(Boolean);
 assert.equal(dueClaims.filter((x)=>x.operation_id===dueOp).length,1,JSON.stringify(dueClaims));
 assert.deepEqual(dueClaims.find((x)=>x.operation_id===dueOp).provider_material,{route:"exact"});
 assert.equal(await sql(`select status||':'||attempt_count from public.booking_payment_operations where id='${dueOp}'`),"reconciling:2");

 const sagaBooking="15160000-0000-4000-8000-000000000700",sagaParent="15160000-0000-4000-8000-000000000701",sagaRequest="15160000-0000-4000-8000-000000000702";
 await sql(`insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,deposit_required,deposit_amount_cents,deposit_status,deposit_paid_at,stripe_payment_intent_id,deposit_payment_ledger_enforced_at) values('${sagaBooking}','${salon}','${service}','${staff}','Saga concurrency','+16045551607',clock_timestamp()+interval '8 days',clock_timestamp()+interval '8 days 30 minutes','confirmed',true,1000,'paid',clock_timestamp(),'pi_saga_concurrency',clock_timestamp());
 insert into public.booking_payment_operations(id,salon_id,booking_id,request_id,operation_kind,provider,provider_account_fingerprint,amount_cents,currency,material_fingerprint,material_json,provider_material,provider_payment_id,provider_idempotency_key,status,result_json,completed_at) values('${sagaParent}','${salon}','${sagaBooking}',gen_random_uuid(),'deposit_charge','stripe',repeat('a',64),1000,'CAD',repeat('b',64),'{}',jsonb_build_object('provider','stripe','provider_account_id','acct_payment_concurrency'),'pi_saga_concurrency','nq:${sagaParent}','succeeded','{}',clock_timestamp());`);
 const sagaClaims=(await Promise.all([1,2].map(()=>sql(`begin;set local role service_role;select public.cancel_booking_with_deposit_refund_saga('${salon}','${sagaBooking}','${sagaRequest}',400,false,null)::text;commit;`)))).map(json);
 assert.equal(sagaClaims.filter((x)=>x.code==="cancelled_refund_claimed").length,1,JSON.stringify(sagaClaims));
 assert.equal(sagaClaims.filter((x)=>x.code==="saga_replay").length,1,JSON.stringify(sagaClaims));
 assert.equal(new Set(sagaClaims.map((x)=>x.refund_operation_id)).size,1,JSON.stringify(sagaClaims));
 assert.equal(await sql(`select count(*)||':'||min(status) from public.booking_cancel_deposit_refund_sagas where salon_id='${salon}' and request_id='${sagaRequest}'`),"1:refund_claimed");

 await sql(`update public.salons set payment_provider='square',stripe_connect_charges_enabled=false where id='${salon}';
 insert into public.square_integrations(salon_id,merchant_id,location_id,access_token,enabled,deposit_enabled,deposit_percent,deposit_risk_threshold,application_id,environment) values('${salon}','merchant_payment_concurrency','location_payment_concurrency','secret-square-token',true,true,20,0,'application_payment_concurrency','sandbox') on conflict(salon_id) do update set merchant_id=excluded.merchant_id,location_id=excluded.location_id,access_token=excluded.access_token,enabled=true,deposit_enabled=true,deposit_percent=20,application_id=excluded.application_id,environment='sandbox';`);
 const hostedBooking="15160000-0000-4000-8000-000000000710",hostedRequest="15160000-0000-4000-8000-000000000711";
 await sql(`insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status,price_cents) values('${hostedBooking}','${salon}','${service}','${staff}','Hosted concurrency','+16045551608',clock_timestamp()+interval '9 days',clock_timestamp()+interval '9 days 30 minutes','confirmed',5000);`);
 const hostedClaims=(await Promise.all([1,2].map(()=>sql(`begin;set local role service_role;select public.claim_booking_square_deposit_link('${salon}','${hostedBooking}','${hostedRequest}',true)::text;commit;`)))).map(json);
 assert.equal(hostedClaims.filter((x)=>x.code==="link_claimed").length,1,JSON.stringify(hostedClaims));
 assert.equal(hostedClaims.filter((x)=>x.code==="link_attempt_replay").length,1,JSON.stringify(hostedClaims));
 assert.equal(new Set(hostedClaims.map((x)=>x.operation_id)).size,1,JSON.stringify(hostedClaims));
 assert.equal(new Set(hostedClaims.map((x)=>x.attempt_token)).size,1,JSON.stringify(hostedClaims));
 const hostedConflict=json(await sql(`begin;set local role service_role;select public.claim_booking_square_deposit_link('${salon}','${hostedBooking}','15160000-0000-4000-8000-000000000712',true)::text;commit;`));
 assert.equal(hostedConflict.code,"booking_deposit_already_claimed",JSON.stringify(hostedConflict));

 const squareOp="15160000-0000-4000-8000-000000000720",squareRequest="15160000-0000-4000-8000-000000000721",squareAttempt="15160000-0000-4000-8000-000000000722";
 const squareToken="public-square-capability-concurrency-token-0001";
 const squareTokenHash=await sql(`select encode(extensions.digest(convert_to('${squareToken}','UTF8'),'sha256'),'hex')`);
 await sql(`insert into public.booking_payment_operations(id,salon_id,request_id,operation_kind,provider,provider_account_fingerprint,amount_cents,currency,material_fingerprint,material_json,provider_material,delivery_mode,booking_intent_idempotency_key,pricing_fingerprint,service_id,staff_id,start_time_utc,end_time_utc,client_phone_fingerprint,provider_idempotency_key,status,attempt_token,lease_expires_at,public_square_capability_token_hash,public_square_capability_expires_at) values('${squareOp}','${salon}','${squareRequest}','deposit_charge','square',repeat('c',64),1000,'CAD',repeat('d',64),'{}',jsonb_build_object('provider','square','provider_account_id','merchant_payment_concurrency','provider_location_id','location_payment_concurrency','provider_application_id','application_payment_concurrency','provider_environment','sandbox'),'public_customer_present',gen_random_uuid(),repeat('e',64),'${service}','${staff}',clock_timestamp()+interval '10 days',clock_timestamp()+interval '10 days 30 minutes',repeat('f',64),'nq:${squareOp}','sending','${squareAttempt}',clock_timestamp()+interval '2 minutes','${squareTokenHash}',clock_timestamp()+interval '15 minutes');`);
 const squareClaims=(await Promise.all([1,2].map(()=>sql(`begin;set local role service_role;select public.claim_public_square_deposit_completion('${squareOp}','${squareRequest}','${squareToken}')::text;commit;`)))).map(json);
 assert.equal(squareClaims.filter((x)=>x.code==="square_payment_claimed").length,1,JSON.stringify(squareClaims));
 assert.equal(squareClaims.filter((x)=>x.code==="square_payment_attempt_replay").length,1,JSON.stringify(squareClaims));
 assert.equal(new Set(squareClaims.map((x)=>x.attempt_token)).size,1,JSON.stringify(squareClaims));
 assert.equal(new Set(squareClaims.map((x)=>x.provider_idempotency_key)).size,1,JSON.stringify(squareClaims));
 process.stdout.write("PASS booking payment concurrency\n");
}finally{await cleanup();}
