#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dbUrl = process.env.DB_URL;
const psql = process.env.PSQL_BIN ?? "psql";
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !dbUrl) {
  throw new Error("Refusing without NAILIQ_DISPOSABLE_DB=1 and DB_URL");
}
const parsed = new URL(dbUrl);
if (!["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(parsed.hostname)) {
  throw new Error(`Refusing non-local database host: ${parsed.hostname}`);
}

const salon = "d6200000-0000-4000-8000-000000000001";
const service = "d6200000-0000-4000-8000-000000000002";
const staff1 = "d6200000-0000-4000-8000-000000000003";
const staff2 = "d6200000-0000-4000-8000-000000000004";
const actor = "d6200000-0000-4000-8000-000000000005";
const group = "d6200000-0000-4000-8000-000000000010";
const request = "d6200000-0000-4000-8000-000000000011";

async function sql(statement) {
  const { stdout } = await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim();
}
function json(output) {
  return JSON.parse(output.split("\n").filter((line) => line.startsWith("{")).at(-1));
}
async function cleanup() {
  await sql(`delete from public.salons where id='${salon}'; delete from auth.users where id='${actor}';
    delete from public.service_categories where slug='staff-action-concurrency-qa';`);
}

try {
  await cleanup();
  await sql(`
    insert into public.service_categories(slug,name_en,name_vi)
    values('staff-action-concurrency-qa','Staff action concurrency','Staff action concurrency');
    -- This fixture exercises active delivery materialization, so opt into both
    -- channels explicitly instead of relying on safe defaults for new salons.
    insert into public.salons(
      id,slug,name,phone,timezone,sms_outbound_enabled,email_outbound_enabled
    ) values(
      '${salon}','e2e-staff-action-concurrency','E2E Staff action concurrency',
      '+16045550620','UTC',true,true
    );
    insert into public.services(id,salon_id,name,price_cents,duration_minutes,category)
    values('${service}','${salon}','Concurrency service',3000,30,'staff-action-concurrency-qa');
    insert into public.staff(id,salon_id,name,status) values
      ('${staff1}','${salon}','Concurrency staff 1','active'),
      ('${staff2}','${salon}','Concurrency staff 2','active');
    insert into auth.users(id,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at)
    values('${actor}','staff-action-concurrency@nailiq.invalid','',now(),
      '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now());
    insert into public.salon_members(salon_id,user_id,role)
    values('${salon}','${actor}','receptionist');
    insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
      client_email,start_time_utc,end_time_utc,status,price_cents,group_id,group_size,
      is_party_member,is_group_organizer) values
      ('d6200000-0000-4000-8000-000000000020','${salon}','${service}','${staff1}',
       'Concurrent lead','+16045550621','concurrent@example.test',now()+interval '2 days',
       now()+interval '2 days 30 minutes','confirmed',3000,'${group}',2,true,true),
      ('d6200000-0000-4000-8000-000000000021','${salon}','${service}','${staff2}',
       'Concurrent member',null,null,now()+interval '2 days',now()+interval '2 days 30 minutes',
       'confirmed',3000,'${group}',2,true,false);
  `);

  const call = `begin; set local role service_role;
    select public.cancel_booking_group_for_desk_with_staff_notification(
      '${salon}','${group}','${request}','${actor}',true,true,20)::text; commit;`;
  const results = (await Promise.all([sql(call), sql(call)])).map(json);
  assert.deepEqual(results.map((r) => r.code), ["group_cancelled", "group_cancelled"]);
  assert.deepEqual(results.map((r) => r.idempotent).sort(), [false, true]);
  assert.equal(results[0].cancelled_count, 2);
  assert.deepEqual(results[0].cancelled_booking_ids, results[1].cancelled_booking_ids);
  assert.equal(await sql(`select count(*) from public.staff_action_group_cancel_receipts where salon_id='${salon}' and request_id='${request}'`), "1");
  assert.equal(await sql(`select count(*) from public.staff_action_notification_outbox where salon_id='${salon}' and request_id='${request}'`), "1");
  assert.equal(await sql(`select count(*) from public.staff_action_notification_deliveries d join public.staff_action_notification_outbox o on o.id=d.outbox_id where o.request_id='${request}'`), "2");
  assert.equal(await sql(`select count(*) from public.bookings where salon_id='${salon}' and group_id='${group}' and status='cancelled'`), "2");

  // Once both channel envelopes are materialized, two workers can lease the
  // batch concurrently without claiming the same delivery twice.
  const rows = JSON.parse(await sql(`select jsonb_agg(jsonb_build_object('id',d.id,'channel',d.channel) order by d.channel)::text
    from public.staff_action_notification_deliveries d join public.staff_action_notification_outbox o on o.id=d.outbox_id
    where o.request_id='${request}'`));
  for (const row of rows) {
    const envelope = row.channel === "sms"
      ? { v:1,kind:"staff_action",channel:"sms",salonId:salon,bookingId:"d6200000-0000-4000-8000-000000000020",event:"cancel",actorUserId:actor,actorRole:"receptionist",to:"+16045550621",body:"Cancelled",statusCallbackUrl:"https://example.test/twilio/status",salonIsTest:true,lang:"en" }
      : { v:1,kind:"staff_action",channel:"email",salonId:salon,bookingId:"d6200000-0000-4000-8000-000000000020",event:"cancel",actorUserId:actor,actorRole:"receptionist",to:"concurrent@example.test",from:"NailIQ <booking@example.test>",subject:"Cancelled",html:"<p>Cancelled</p>",text:"Cancelled",headers:{},replyTo:null };
    const rawValue = JSON.stringify(envelope);
    const raw = rawValue.replaceAll("'", "''");
    const payloadHash = createHash("sha256").update(rawValue, "utf8").digest("hex");
    const recipientHash = createHash("sha256")
      .update(row.channel === "sms" ? "16045550621" : "concurrent@example.test", "utf8")
      .digest("hex");
    await sql(`begin; set local role service_role;
      select public.materialize_staff_action_notification_delivery('${row.id}',
        '${payloadHash}','${recipientHash}',
      '${raw}'); commit;`);
  }
  await sql(`update public.staff_action_notification_outbox
    set send_after=clock_timestamp()-interval '1 second',
        expires_at=clock_timestamp()+interval '29 minutes'
    where request_id='${request}'`);
  const lease = `begin; set local role service_role;
    select value::text from public.lease_due_staff_action_notification_deliveries(2) value; commit;`;
  const leased = (await Promise.all([sql(lease), sql(lease)]))
    .flatMap((out) => out.split("\n").filter((line) => line.startsWith("{")))
    .map(JSON.parse);
  assert.equal(leased.length, 2);
  assert.equal(new Set(leased.map((r) => r.delivery_id)).size, 2);
  assert.deepEqual(leased.map((r) => r.attempt_count), [1, 1]);
  process.stdout.write("PASS concurrent group mutation exact replay and distinct SKIP LOCKED channel leases\n");
} finally {
  await cleanup();
}
