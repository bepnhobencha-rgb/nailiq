#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);
const dbUrl=process.env.DB_URL;
const psql=process.env.PSQL_BIN??"psql";
if(process.env.NAILIQ_DISPOSABLE_DB!=="1"||!dbUrl){
  throw new Error("Refusing without NAILIQ_DISPOSABLE_DB=1 and DB_URL");
}
const parsed=new URL(dbUrl);
if(!["localhost","127.0.0.1","::1","[::1]",""] .includes(parsed.hostname)){
  throw new Error(`Refusing non-local database host: ${parsed.hostname}`);
}

const salon="c6000000-0000-4000-8000-000000000001";
const service="c6000000-0000-4000-8000-000000000002";
const staff="c6000000-0000-4000-8000-000000000003";
const booking="c6000000-0000-4000-8000-000000000004";
const email="transition-concurrency@example.test";
const recipient=createHash("sha256").update(email).digest("hex");
const payload="b".repeat(64);

async function sql(statement){
  const {stdout}=await execFileAsync(psql,[dbUrl,"-X","-v","ON_ERROR_STOP=1","-Atq","-c",statement],{
    encoding:"utf8",timeout:20000,maxBuffer:4*1024*1024,
  });
  return stdout.trim();
}
function json(output){return JSON.parse(output.split("\n").filter(Boolean).at(-1));}
async function cleanup(){
  await sql(`delete from public.salons where id='${salon}'; delete from public.service_categories where slug='transition-email-concurrency-qa';`);
}

try{
  await cleanup();
  await sql(`
    insert into public.service_categories(slug,name_en,name_vi)
    values('transition-email-concurrency-qa','Transition concurrency','Transition concurrency');
    insert into public.salons(id,slug,name,phone,timezone)
    values('${salon}','transition-email-concurrency-qa','Transition concurrency','+16045550301','UTC');
    insert into public.services(id,salon_id,name,price_cents,duration_minutes,category)
    values('${service}','${salon}','Transition service',3000,30,'transition-email-concurrency-qa');
    insert into public.staff(id,salon_id,name,status)
    values('${staff}','${salon}','Transition staff','active');
    insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_email,
      start_time_utc,end_time_utc,status,price_cents)
    values('${booking}','${salon}','${service}','${staff}','Transition guest','${email}',
      clock_timestamp()+interval '2 days',clock_timestamp()+interval '2 days 30 minutes','confirmed',3000);
    begin; set local role service_role;
    update public.bookings set start_time_utc=start_time_utc+interval '1 hour',
      end_time_utc=end_time_utc+interval '1 hour',customer_transition_email_requested=true,
      customer_transition_email_not_before=clock_timestamp() where id='${booking}';
    commit;
  `);
  const claimSql=`begin; set local role service_role; select public.claim_customer_booking_transition_email(
    '${salon}','${booking}','reschedule',1,'${payload}','${recipient}')::text; commit;`;
  const claims=(await Promise.all([sql(claimSql),sql(claimSql)])).map(json);
  assert.deepEqual(claims.map((v)=>v.code).sort(),["claimed","in_flight"]);
  const winner=claims.find((v)=>v.claimed===true);
  assert.ok(winner?.outbox_id&&winner?.attempt_token);
  assert.equal(await sql(`select count(*) from public.customer_booking_transition_email_outbox where booking_id='${booking}'`),"1");

  const completed=json(await sql(`begin; set local role service_role;
    select public.complete_customer_booking_transition_email('${winner.outbox_id}','${winner.attempt_token}',
      'failed',null,'email_unavailable_pre_acceptance','retryable_pre_acceptance')::text; commit;`));
  assert.equal(completed.retry_scheduled,true);
  await sql(`update public.customer_booking_transition_email_outbox set next_attempt_at=clock_timestamp()-interval '1 second' where id='${winner.outbox_id}'`);
  const leaseSql=`begin; set local role service_role;
    select value::text from public.lease_due_customer_booking_transition_email_retries(1) value; commit;`;
  const leased=(await Promise.all([sql(leaseSql),sql(leaseSql)]))
    .flatMap((output)=>output.split("\n").filter((line)=>line.startsWith("{"))).map(JSON.parse);
  assert.equal(leased.length,1);
  assert.equal(leased[0].outbox_id,winner.outbox_id);
  assert.equal(leased[0].attempt_count,2);
  assert.equal(leased[0].payload_fingerprint,payload);
  assert.equal(leased[0].recipient_fingerprint,recipient);
  assert.equal(await sql(`select count(*) from public.customer_booking_transition_email_events where outbox_id='${winner.outbox_id}' and transition='retry_leased'`),"1");
  process.stdout.write("PASS concurrent transition claim and SKIP LOCKED retry lease\n");
}finally{
  await cleanup();
}
