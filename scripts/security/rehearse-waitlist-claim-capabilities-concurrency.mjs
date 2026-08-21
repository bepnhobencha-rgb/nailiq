#!/usr/bin/env node
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const run=promisify(execFile),dbUrl=process.env.DB_URL,psql=process.env.PSQL_BIN??"psql";
if(process.env.NAILIQ_DISPOSABLE_DB!=="1"||!dbUrl) throw new Error("disposable local DB required");
if(!["localhost","127.0.0.1","::1","[::1]",""] .includes(new URL(dbUrl).hostname)) throw new Error("non-local DB");
async function sql(q){const {stdout}=await run(psql,[dbUrl,"-X","-v","ON_ERROR_STOP=1","-Atq","-c",q],{encoding:"utf8",timeout:30000,maxBuffer:4e6});return stdout.trim();}
function json(s){return JSON.parse(s.split("\n").filter((x)=>x.startsWith("{")).at(-1));}
const salon="d9000000-0000-4000-8000-000000000001",service="d9000000-0000-4000-8000-000000000002",staff="d9000000-0000-4000-8000-000000000003",entry="d9000000-0000-4000-8000-000000000010",legacy="d9000000-0000-4000-8000-000000000011",request="d9000000-0000-4000-8000-000000000020",freed="d9000000-0000-4000-8000-000000000030",phone="+16045550999",recipient=createHash("sha256").update(phone).digest("hex");
async function cleanup(){await sql(`delete from public.salons where id='${salon}';delete from public.service_categories where slug='waitlist-concurrency-qa'`);}
try{
 await cleanup();
 await sql(`insert into public.service_categories(slug,name_en,name_vi) values('waitlist-concurrency-qa','Waitlist concurrency','Waitlist concurrency');
 insert into public.salons(id,slug,name,phone,timezone,feature_flags) values('${salon}','waitlist-concurrency-qa','Waitlist concurrency','+16045550888','UTC','{}');
 insert into public.services(id,salon_id,name,price_cents,duration_minutes,category) values('${service}','${salon}','Waitlist service',2000,30,'waitlist-concurrency-qa');
 insert into public.staff(id,salon_id,name,status) values('${staff}','${salon}','Waitlist staff','active');
 insert into public.booking_waitlist_entries(id,salon_id,service_id,booking_date,client_name,client_phone,status,source,notified_at,claim_token) values
 ('${entry}','${salon}','${service}',current_date+1,'Waitlist concurrent','${phone}','notified','slot_unavailable',clock_timestamp(),'${legacy}'),
 ('d9000000-0000-4000-8000-000000000031','${salon}','${service}',current_date+2,'FIFO first','${phone}','waiting','slot_unavailable',null,null),
 ('d9000000-0000-4000-8000-000000000032','${salon}','${service}',current_date+2,'FIFO second','${phone}','waiting','slot_unavailable',null,null);
 insert into public.booking_waitlist_entries(id,salon_id,service_id,booking_date,client_name,client_phone,status,source)
 values('d9000000-0000-4000-8000-000000000033','${salon}','${service}',current_date+3,'Manual exact','${phone}','waiting','slot_unavailable');
 insert into public.bookings(id,salon_id,service_id,staff_id,client_name,start_time_utc,end_time_utc,status,price_cents)
 values('${freed}','${salon}','${service}','${staff}','Freed booking',clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 30 minutes','cancelled',2000)`);
 const expiry=new Date(Date.now()+1800_000).toISOString();
 const mint=`begin;set local role service_role;select public.mint_waitlist_claim_capability('${salon}','${entry}','${expiry}')::text;commit;`;
 const minted=(await Promise.all(Array.from({length:20},()=>sql(mint)))).map(json);
 assert.equal(new Set(minted.map((x)=>x.token_id)).size,1); const token=minted[0].token_id;
 const material=await sql(`select material_fingerprint from public.waitlist_offer_delivery_outbox where waitlist_entry_id='${entry}' and channel='sms'`);
 const delivery=`begin;set local role service_role;select public.claim_waitlist_offer_delivery('${salon}','${entry}',1,'sms','${token}','${recipient}','${material}','${"b".repeat(64)}')::text;commit;`;
 const deliveryResults=(await Promise.all([sql(delivery),sql(delivery)])).map(json);
 assert.deepEqual(deliveryResults.map((x)=>x.code).sort(),["claimed","in_flight"]);
 const winner=deliveryResults.find((x)=>x.code==="claimed");
 const completed=json(await sql(`begin;set local role service_role;select public.complete_waitlist_offer_delivery('${winner.outbox_id}','${winner.attempt_token}','unknown',null,'transport_ambiguous')::text;commit;`));
 assert.equal(completed.status,"unknown");
 assert.equal(json(await sql(delivery)).code,"terminal");
 const claim=`begin;set local role service_role;select public.claim_waitlist_with_management_capability('${token}','${request}')::text;commit;`;
 const claims=(await Promise.all(Array.from({length:10},()=>sql(claim)))).map(json);
 assert.ok(claims.every((x)=>x.code==="claimed"));
 assert.equal(claims.filter((x)=>x.idempotent===false).length,1);
 assert.equal(await sql(`select count(*) from public.waitlist_claim_action_receipts where waitlist_entry_id='${entry}'`),"1");
 const promotions=(await Promise.all(Array.from({length:10},()=>sql(`begin;set local role service_role;select public.promote_waitlist_for_booking('${freed}')::text;commit;`)))).map(json);
 assert.ok(promotions.every((x)=>x.code==="promoted"));
 assert.equal(promotions.filter((x)=>x.idempotent===false).length,1);
 assert.equal(new Set(promotions.map((x)=>x.claim_capability_token)).size,1);
 assert.equal(await sql(`select count(*) from public.waitlist_offer_promotion_receipts where source_booking_id='${freed}'`),"1");
 assert.equal(await sql(`select count(*) from public.booking_waitlist_entries where salon_id='${salon}' and booking_date=current_date+2 and status='notified'`),"1");
 assert.equal(await sql(`select count(*) from public.booking_waitlist_entries where salon_id='${salon}' and booking_date=current_date+2 and status='waiting'`),"1");
 const selected=(await Promise.all(Array.from({length:10},()=>sql(`begin;set local role service_role;select public.promote_waitlist_entry('${salon}','d9000000-0000-4000-8000-000000000033',20)::text;commit;`)))).map(json);
 assert.ok(selected.every((x)=>x.code==="promoted"));
 assert.equal(selected.filter((x)=>x.idempotent===false).length,1);
 assert.equal(new Set(selected.map((x)=>x.claim_capability_token)).size,1);
 assert.equal(await sql(`select count(*) from public.waitlist_offer_delivery_outbox where waitlist_entry_id='d9000000-0000-4000-8000-000000000033'`),"2");
 process.stdout.write("PASS waitlist capability claim/delivery concurrency\n");
}finally{await cleanup();}
