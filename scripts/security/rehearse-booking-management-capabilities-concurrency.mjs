#!/usr/bin/env node
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const run=promisify(execFile); const dbUrl=process.env.DB_URL; const psql=process.env.PSQL_BIN??"psql";
if(process.env.NAILIQ_DISPOSABLE_DB!=="1"||!dbUrl) throw new Error("disposable local DB required");
const host=new URL(dbUrl).hostname;
if(!["localhost","127.0.0.1","::1","[::1]",""] .includes(host)) throw new Error(`non-local host ${host}`);
async function sql(q){const {stdout}=await run(psql,[dbUrl,"-X","-v","ON_ERROR_STOP=1","-Atq","-c",q],{encoding:"utf8",timeout:30000,maxBuffer:4e6});return stdout.trim();}
function json(s){return JSON.parse(s.split("\n").filter((x)=>x.startsWith("{")).at(-1));}
const salon="d8000000-0000-4000-8000-000000000001",service="d8000000-0000-4000-8000-000000000002",staff="d8000000-0000-4000-8000-000000000003",booking="d8000000-0000-4000-8000-000000000010",race="d8000000-0000-4000-8000-000000000011",cardBooking="d8000000-0000-4000-8000-000000000012",saveBooking="d8000000-0000-4000-8000-000000000013";
async function cleanup(){await sql(`delete from public.salons where id='${salon}'; delete from public.service_categories where slug='management-concurrency-qa'`);}
try{
 await cleanup();
 await sql(`insert into public.service_categories(slug,name_en,name_vi) values('management-concurrency-qa','Management concurrency','Management concurrency');
 insert into public.salons(id,slug,name,phone,timezone) values('${salon}','management-concurrency-qa','Management concurrency','+16045550901','UTC');
 insert into public.services(id,salon_id,name,price_cents,duration_minutes,category) values('${service}','${salon}','Concurrency service',2000,30,'management-concurrency-qa');
 insert into public.staff(id,salon_id,name,status) values('${staff}','${salon}','Concurrency staff','active');
 insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_email,start_time_utc,end_time_utc,status,price_cents) values
 ('${booking}','${salon}','${service}','${staff}','Concurrency','qa@example.test',clock_timestamp()+interval '10 days',clock_timestamp()+interval '10 days 30 minutes','confirmed',2000),
 ('${race}','${salon}','${service}','${staff}','Race','qa@example.test',clock_timestamp()+interval '12 days',clock_timestamp()+interval '12 days 30 minutes','confirmed',2000),
 ('${cardBooking}','${salon}','${service}','${staff}','Card','qa@example.test',clock_timestamp()+interval '14 days',clock_timestamp()+interval '14 days 30 minutes','confirmed',2000),
 ('${saveBooking}','${salon}','${service}','${staff}','Save card','save@example.test',clock_timestamp()+interval '15 days',clock_timestamp()+interval '15 days 30 minutes','confirmed',2000);
 update public.bookings set noshow_card_id='card_concurrency',noshow_customer_id='customer_concurrency',
   noshow_charge_status='card_on_file' where id='${cardBooking}'`);
 const expiry=new Date(Date.now()+3600_000).toISOString();
 const newStart=new Date(Date.now()+11*86400_000).toISOString(),newEnd=new Date(Date.now()+11*86400_000+1800_000).toISOString();
 const mint=`begin;set local role service_role;select public.mint_booking_management_capability('${salon}','${booking}','reschedule','${expiry}')::text;commit;`;
 const minted=(await Promise.all(Array.from({length:20},()=>sql(mint)))).map(json);
 assert.equal(new Set(minted.map((x)=>x.token_id)).size,1); const token=minted[0].token_id;
 const request="d8000000-0000-4000-8000-000000000080";
 const mutate=`begin;set local role service_role;select public.reschedule_booking_with_management_capability('${token}','${request}','${newStart}','${newEnd}')::text;commit;`;
 const results=(await Promise.all(Array.from({length:10},()=>sql(mutate)))).map(json);
 assert.ok(results.every((x)=>x.code==="rescheduled"));
 assert.equal(results.filter((x)=>x.idempotent===false).length,1);
 assert.equal(await sql(`select count(*) from public.customer_booking_transition_email_outbox where booking_id='${booking}' and event_type='reschedule'`),"1");
 const resToken=json(await sql(`begin;set local role service_role;select public.mint_booking_management_capability('${salon}','${race}','reschedule',clock_timestamp()+interval '1 hour')::text;commit;`)).token_id;
 const canToken=json(await sql(`begin;set local role service_role;select public.mint_booking_management_capability('${salon}','${race}','cancel',clock_timestamp()+interval '1 hour')::text;commit;`)).token_id;
 const [a,b]=await Promise.all([
   sql(`begin;set local role service_role;select public.reschedule_booking_with_management_capability('${resToken}','d8000000-0000-4000-8000-000000000081',clock_timestamp()+interval '13 days',clock_timestamp()+interval '13 days 30 minutes')::text;commit;`),
   sql(`begin;set local role service_role;select public.cancel_booking_with_management_capability('${canToken}','d8000000-0000-4000-8000-000000000082')::text;commit;`)
 ]).then((xs)=>xs.map(json));
 assert.equal([a,b].filter((x)=>["rescheduled","cancelled"].includes(x.code)).length,1);
 assert.equal([a,b].filter((x)=>["booking_state_changed","expired_or_revoked"].includes(x.code)).length,1);
 assert.equal(await sql(`select count(*) from public.customer_booking_transition_email_outbox where booking_id='${race}'`),"1");
 const cardToken=json(await sql(`begin;set local role service_role;select public.mint_booking_management_capability('${salon}','${cardBooking}','card_manage',clock_timestamp()+interval '10 minutes')::text;commit;`)).token_id;
 const cardInspect=json(await sql(`begin;set local role service_role;select public.inspect_booking_management_capability('${cardToken}','card_manage')::text;commit;`));
 const cardFp=cardInspect.card_manage.card_fingerprint,cardRequest="d8000000-0000-4000-8000-000000000083";
 const cardClaims=(await Promise.all(Array.from({length:10},()=>sql(`begin;set local role service_role;select public.claim_booking_card_management_operation('${cardToken}','${cardRequest}','${cardFp}')::text;commit;`)))).map(json);
 assert.ok(cardClaims.every((x)=>x.code==="claimed"));
 assert.equal(cardClaims.filter((x)=>x.attempt_replay===false).length,1);
 assert.equal(cardClaims.filter((x)=>x.attempt_replay===true).length,9);
 assert.equal(new Set(cardClaims.map((x)=>x.provider_idempotency_key)).size,1);
 const claimed=cardClaims.find((x)=>x.attempt_replay===false);
 const completions=(await Promise.all(Array.from({length:10},()=>sql(`begin;set local role service_role;select public.complete_booking_card_management_operation('${claimed.operation_id}','${claimed.attempt_token}','succeeded','square-remove-concurrency',null)::text;commit;`)))).map(json);
 assert.ok(completions.every((x)=>x.code==="removed"));
 assert.equal(completions.filter((x)=>x.idempotent===false).length,1);
 assert.equal(await sql(`select count(*) from public.bookings where id='${cardBooking}' and noshow_card_id is null and noshow_charge_status='removed_by_customer'`),"1");
 const saveToken=json(await sql(`begin;set local role service_role;select public.mint_booking_management_capability('${salon}','${saveBooking}','card_manage',clock_timestamp()+interval '10 minutes')::text;commit;`)).token_id;
 const saveRequest="d8000000-0000-4000-8000-000000000084",sourceFp="a".repeat(64);
 const saveClaims=(await Promise.all(Array.from({length:10},()=>sql(`begin;set local role service_role;select public.claim_booking_card_save_operation('${saveToken}','${saveRequest}','square','save_card','${sourceFp}')::text;commit;`)))).map(json);
 assert.ok(saveClaims.every((x)=>x.code==="claimed"));
 assert.equal(saveClaims.filter((x)=>x.attempt_replay===false).length,1);
 assert.equal(saveClaims.filter((x)=>x.attempt_replay===true).length,9);
 assert.equal(new Set(saveClaims.map((x)=>x.provider_idempotency_key)).size,1);
 const saveClaimed=saveClaims.find((x)=>x.attempt_replay===false);
 const consentAt=new Date().toISOString();
 const saveCompletions=(await Promise.all(Array.from({length:10},()=>sql(`begin;set local role service_role;select public.complete_booking_card_save_operation('${saveClaimed.operation_id}','${saveClaimed.attempt_token}','succeeded','square-save-concurrency','card_saved_concurrency','customer_saved_concurrency','Visa','4242','${consentAt}'::timestamptz,'{}'::jsonb,null)::text;commit;`)))).map(json);
 assert.ok(saveCompletions.every((x)=>x.code==="saved"),JSON.stringify(saveCompletions));
 assert.equal(saveCompletions.filter((x)=>x.idempotent===false).length,1);
 assert.equal(await sql(`select count(*) from public.bookings where id='${saveBooking}' and noshow_card_id='card_saved_concurrency' and noshow_card_last4='4242' and noshow_charge_status='saved'`),"1");
 process.stdout.write("PASS booking capability concurrent mint/replay/race\n");
}finally{await cleanup();}
