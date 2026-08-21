#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const dbUrl = process.env.DB_URL;
const psql = process.env.PSQL_BIN ?? "psql";
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !dbUrl) {
  throw new Error("Refusing without NAILIQ_DISPOSABLE_DB=1 and DB_URL");
}
const host = new URL(dbUrl).hostname;
if (!["", "localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-local database host: ${host}`);
}

const run = async (sql) => (
  await runFile(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  )
).stdout.trim();
const json = (out) => JSON.parse(
  out.split("\n").filter((line) => line.startsWith("{")).at(-1),
);

const salon = "51020000-0000-4000-8000-000000000301";
const requestA = "51020000-0000-4000-8000-000000000302";
const requestB = "51020000-0000-4000-8000-000000000303";
const requestStart = "51020000-0000-4000-8000-000000000304";
const requestStop = "51020000-0000-4000-8000-000000000305";
const key = "51020000-0000-4000-8000-000000000306";

const cleanup = async () => {
  await run(`
    delete from public.sms_consent_salon_states
      where salon_id='${salon}';
    delete from public.sms_consent_provider_states
      where latest_event_id in (
        select id from public.sms_consent_events
        where request_id in ('${requestA}','${requestB}',
          '${requestStart}','${requestStop}')
      );
    delete from public.sms_consent_events
      where request_id in ('${requestA}','${requestB}',
        '${requestStart}','${requestStop}');
    delete from public.salons where id='${salon}';
  `).catch(() => {});
};

try {
  await cleanup();
  await run(`
    insert into public.salons(
      id,slug,name,phone,email,timezone,sms_outbound_enabled
    ) values(
      '${salon}','sms-consent-race','SMS Consent Race',
      '16045550131','race@example.test','UTC',true
    );
    insert into public.platform_settings(
      id,twilio_account_sid,twilio_phone_number,
      sms_consent_hash_secret,sms_consent_hash_key_id
    ) values(
      'platform','AC0123456789ABCDEF0123456789ABCDEF','+16045550100',
      repeat('r',32),'${key}'
    ) on conflict(id) do update set
      twilio_account_sid=excluded.twilio_account_sid,
      twilio_phone_number=excluded.twilio_phone_number,
      sms_consent_hash_secret=excluded.sms_consent_hash_secret,
      sms_consent_hash_key_id=excluded.sms_consent_hash_key_id;
  `);

  const context = json(await run("select public.sms_consent_provider_context()::text"));
  const hashed = json(await run("select public.hash_sms_consent_phone('+16045550132')::text"));
  assert.equal(context.code, "loaded");
  assert.equal(hashed.code, "hashed");

  const claimSql = (request) => `
    select public.claim_sms_consent_event(
      '${request}','provider_sender','provider_stop','twilio_webhook',
      '${salon}','${hashed.phone_hash}','${key}',
      '${context.provider_account_fingerprint}',
      '${context.sender_fingerprint}',
      'SM8123456789abcdef0123456789abcdef',
      'SM8123456789abcdef0123456789abcdef',null
    )::text;
  `;
  const [claimA, claimB] = (await Promise.all([
    run(claimSql(requestA)), run(claimSql(requestB)),
  ])).map(json);
  assert.deepEqual(
    [claimA.code, claimB.code].sort(),
    ["claimed", "provider_event_replay"],
  );
  assert.equal(claimA.event_id, claimB.event_id);
  assert.equal(claimA.material_fingerprint, claimB.material_fingerprint);

  const event = json(await run(`
    select jsonb_build_object(
      'id',id,'request_id',request_id,
      'material_fingerprint',material_fingerprint
    )::text from public.sms_consent_events
    where id='${claimA.event_id}'
  `));
  const recordSql = `select public.record_sms_consent_event(
    '${event.id}','${event.request_id}','${event.material_fingerprint}'
  )::text`;
  const [recordA, recordB] = (await Promise.all([
    run(recordSql), run(recordSql),
  ])).map(json);
  assert.equal(recordA.code, "applied");
  assert.deepEqual(recordA, recordB);
  assert.equal(Number(await run(`
    select count(*) from public.sms_consent_events
    where provider_event_id='SM8123456789abcdef0123456789abcdef'
  `)), 1);
  assert.equal(Number(await run(`
    select state_epoch from public.sms_consent_provider_states
    where phone_hash='${hashed.phone_hash}'
  `)), 1);

  // Concurrent equal-time STOP/START converges to STOP regardless lock order.
  const tieHash = json(await run(
    "select public.hash_sms_consent_phone('+16045550133')::text",
  ));
  const occurred = new Date(Date.now() + 1000).toISOString();
  const start = json(await run(`select public.claim_sms_consent_event(
    '${requestStart}','provider_sender','provider_start','twilio_event_stream',
    null,'${tieHash.phone_hash}','${key}',
    '${context.provider_account_fingerprint}','${context.sender_fingerprint}',
    'EZ8123456789abcdef0123456789abcdef',
    'SM9123456789abcdef0123456789abcdef','${occurred}'
  )::text`));
  const stop = json(await run(`select public.claim_sms_consent_event(
    '${requestStop}','provider_sender','provider_stop','twilio_event_stream',
    null,'${tieHash.phone_hash}','${key}',
    '${context.provider_account_fingerprint}','${context.sender_fingerprint}',
    'EZ9123456789abcdef0123456789abcdef',
    'SMa123456789abcdef0123456789abcdef','${occurred}'
  )::text`));
  assert.equal(start.code, "claimed");
  assert.equal(stop.code, "claimed");
  await Promise.all([
    run(`select public.record_sms_consent_event(
      '${start.event_id}','${requestStart}','${start.material_fingerprint}')`),
    run(`select public.record_sms_consent_event(
      '${stop.event_id}','${requestStop}','${stop.material_fingerprint}')`),
  ]);
  const decision = json(await run(`select public.load_sms_outbound_suppression(
    '${salon}','${tieHash.phone_hash}','${key}')::text`));
  assert.equal(decision.reason, "provider_stop");
  assert.equal(decision.suppressed, true);

  console.log("sms consent suppression concurrency passed");
} finally {
  await cleanup();
}
