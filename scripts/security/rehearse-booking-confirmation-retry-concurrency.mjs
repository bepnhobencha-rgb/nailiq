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

const salon = "b4000000-0000-4000-8000-000000000001";
const service = "b4000000-0000-4000-8000-000000000002";
const staff = "b4000000-0000-4000-8000-000000000003";
const booking = "b4000000-0000-4000-8000-000000000004";
const phone = "16045550300";
const envelope = JSON.stringify({
  v: 1,
  channel: "sms",
  salonId: salon,
  to: `+${phone}`,
  body: "Concurrent booking confirmation",
  statusCallbackUrl: "https://example.test/twilio/status",
  salonIsTest: true,
  lang: "en",
});
const payload = createHash("sha256").update(envelope, "utf8").digest("hex");
const sqlEnvelope = envelope.replaceAll("'", "''");

async function sql(statement) {
  const { stdout } = await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim();
}
function json(output) {
  return JSON.parse(output.split("\n").filter(Boolean).at(-1));
}
async function cleanup() {
  await sql(`
    delete from public.salons where id='${salon}';
    delete from public.service_categories where slug='retry-concurrency-qa';
  `);
}

try {
  await cleanup();
  await sql(`
    insert into public.service_categories(slug,name_en,name_vi)
    values('retry-concurrency-qa','Retry concurrency','Retry concurrency');
    insert into public.salons(id,slug,name,phone,timezone)
    values('${salon}','retry-concurrency-qa','Retry concurrency','+16045550301','UTC');
    insert into public.services(id,salon_id,name,price_cents,duration_minutes,category)
    values('${service}','${salon}','Retry service',3000,30,'retry-concurrency-qa');
    insert into public.staff(id,salon_id,name,status)
    values('${staff}','${salon}','Retry staff','active');
    insert into public.bookings(
      id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
      start_time_utc,end_time_utc,status,price_cents,sms_consent_at,sms_consent_meta
    ) values(
      '${booking}','${salon}','${service}','${staff}','Retry guest','+${phone}',
      'retry-concurrency@example.test',clock_timestamp()+interval '3 hours',
      clock_timestamp()+interval '3 hours 30 minutes','confirmed',3000,clock_timestamp(),'{"source":"qa"}'::jsonb
    );
  `);
  const recipient = await sql(`select encode(extensions.digest(convert_to('${phone}','UTF8'),'sha256'),'hex')`);
  const claimSql = `
    begin; set local role service_role;
    select public.claim_booking_confirmation_delivery(
      '${salon}','${booking}','sms','${payload}','${recipient}','${sqlEnvelope}'
    )::text; commit;
  `;
  const claims = (await Promise.all([sql(claimSql), sql(claimSql)])).map(json);
  assert.deepEqual(claims.map((r) => r.code).sort(), ["claimed", "in_flight"]);
  const winner = claims.find((r) => r.claimed === true);
  assert.ok(winner?.claim_id && winner?.attempt_token);
  assert.equal(await sql(`select count(*) from public.booking_notifications where booking_id='${booking}' and channel='sms' and notification_type='booking_confirmation'`), "1");
  assert.equal(await sql(`select count(*) from public.booking_confirmation_dispatch_envelopes where claim_id='${winner.claim_id}' and dispatch_envelope='${sqlEnvelope}'`), "1");

  const complete = json(await sql(`
    begin; set local role service_role;
    select public.complete_booking_confirmation_delivery(
      '${winner.claim_id}','${winner.attempt_token}','failed',null,
      'sms_unavailable_pre_acceptance','retryable_pre_acceptance'
    )::text; commit;
  `));
  assert.equal(complete.retry_scheduled, true);
  await sql(`update public.booking_notifications set next_attempt_at=clock_timestamp()-interval '1 second' where id='${winner.claim_id}'`);

  const leaseSql = `
    begin; set local role service_role;
    select value::text from public.lease_due_booking_confirmation_retries(1) value;
    commit;
  `;
  const leased = (await Promise.all([sql(leaseSql), sql(leaseSql)]))
    .flatMap((output) => output.split("\n").filter((line) => line.startsWith("{")))
    .map(JSON.parse);
  assert.equal(leased.length, 1);
  assert.equal(leased[0].claim_id, winner.claim_id);
  assert.equal(leased[0].attempt_count, 2);
  assert.equal(leased[0].dispatch_envelope, envelope);
  assert.equal(leased[0].payload_fingerprint, payload);
  assert.equal(leased[0].recipient_fingerprint, recipient);
  assert.equal(await sql(`select attempt_count from public.booking_notifications where id='${winner.claim_id}'`), "2");
  assert.equal(await sql(`select count(*) from public.booking_notification_delivery_events where claim_id='${winner.claim_id}' and transition='retry_leased'`), "1");

  const terminal = json(await sql(`
    begin; set local role service_role;
    select public.complete_booking_confirmation_delivery(
      '${winner.claim_id}','${leased[0].attempt_token}','sent',
      'SM0123456789abcdef0123456789abcdef',null,'none'
    )::text; commit;
  `));
  assert.equal(terminal.status, "sent");
  assert.equal(await sql(`select count(*) from public.booking_confirmation_dispatch_envelopes where claim_id='${winner.claim_id}'`), "0");

  process.stdout.write("PASS concurrent immutable claim, single SKIP LOCKED lease, terminal cleanup\n");
} finally {
  await cleanup();
}
