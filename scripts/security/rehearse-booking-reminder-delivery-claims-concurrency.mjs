#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dbUrl = process.env.DB_URL;
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !dbUrl) {
  throw new Error("Refusing without NAILIQ_DISPOSABLE_DB=1 and DB_URL");
}
const host = new URL(dbUrl).hostname;
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-local database host: ${host}`);
}

const salon = "18000010-0000-4000-8000-000000000001";
const service = "18000010-0000-4000-8000-000000000002";
const staff = "18000010-0000-4000-8000-000000000003";
const booking = "18000010-0000-4000-8000-000000000004";
const start = "2026-08-25T18:00:00Z";

async function sql(statement) {
  const { stdout } = await execFileAsync(
    process.env.PSQL_BIN ?? "psql",
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return stdout.trim();
}
function json(output) {
  return JSON.parse(output.split("\n").findLast((line) => line.startsWith("{")));
}
async function cleanup() {
  await sql(`delete from public.salons where id='${salon}';
    delete from public.service_categories where slug='reminder-claim-concurrency-qa';`);
}

try {
  await cleanup();
  await sql(`
    insert into public.service_categories(slug,name_en,name_vi)
    values('reminder-claim-concurrency-qa','Reminder concurrency','Reminder concurrency');
    insert into public.salons(id,slug,name,phone,timezone,is_beta)
    values('${salon}','reminder-claim-concurrency-qa','Reminder Claim Concurrency QA','+16045551819','UTC',true);
    insert into public.services(id,salon_id,name,price_cents,duration_minutes,category)
    values('${service}','${salon}','Reminder service',2500,30,'reminder-claim-concurrency-qa');
    insert into public.staff(id,salon_id,name,status)
    values('${staff}','${salon}','Reminder staff','active');
    insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
      client_email,start_time_utc,end_time_utc,status,price_cents)
    values('${booking}','${salon}','${service}','${staff}','Reminder Fixture',
      '+16045551818','reminder@nailiq.invalid','${start}','2026-08-25T18:30:00Z','confirmed',2500);
  `);
  const call = `select public.claim_booking_reminder_delivery(
    '${salon}','${booking}','${start}','24h','sms')::text`;
  const rows = (await Promise.all([sql(call), sql(call)])).map(json);
  assert.deepEqual(rows.map((row) => row.claimed).sort(), [false, true]);
  assert.equal(new Set(rows.map((row) => row.claim_id)).size, 1);
  assert.equal(
    await sql(`select count(*) from public.booking_reminder_delivery_claims
      where booking_id='${booking}' and reminder_type='24h' and channel='sms'`),
    "1",
  );
  process.stdout.write("PASS booking reminder delivery claim concurrency\n");
} finally {
  await cleanup();
}
