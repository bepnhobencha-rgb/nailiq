#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const dbUrl = process.env.DB_URL;
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !dbUrl) {
  throw new Error("NAILIQ_DISPOSABLE_DB=1 and local DB_URL are required");
}
const parsed = new URL(dbUrl);
if (
  !["postgres:", "postgresql:"].includes(parsed.protocol) ||
  !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)
) {
  throw new Error(`refusing non-local database ${parsed.hostname}`);
}

const psql = process.env.PSQL_BIN ?? "psql";
const salon = "10100010-0000-4000-8000-000000000001";
const service = "10100010-0000-4000-8000-000000000002";
const staff = "10100010-0000-4000-8000-000000000003";
const booking = "10100010-0000-4000-8000-000000000004";
const genericNotification = "10100010-0000-4000-8000-000000000005";
const staffOutbox = "10100010-0000-4000-8000-000000000006";
const staffDelivery = "10100010-0000-4000-8000-000000000007";
const staffRequest = "10100010-0000-4000-8000-000000000008";
const staffAttempt = "10100010-0000-4000-8000-000000000009";
const reviewNotification = "10100010-0000-4000-8000-000000000010";
const start = "2026-08-25T19:00:00Z";
const sids = {
  replay: `SM${"a".repeat(32)}`,
  completionRace: `MM${"b".repeat(32)}`,
  conflict: `SM${"c".repeat(32)}`,
  genericRace: `MM${"d".repeat(32)}`,
  staffRace: `SM${"e".repeat(32)}`,
  reviewRace: `MM${"f".repeat(32)}`,
};

async function sql(statement) {
  const { stdout } = await run(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        PGCONNECT_TIMEOUT: "3",
      },
    },
  );
  return stdout.trim();
}

function json(output) {
  const line = output.split("\n").findLast((value) => value.startsWith("{"));
  if (!line) throw new Error(`missing JSON result: ${output}`);
  return JSON.parse(line);
}

const serviceCall = (query) => sql(
  `BEGIN; SET LOCAL ROLE service_role; SELECT (${query})::text; COMMIT;`,
).then(json);

async function claim(reminderType) {
  return serviceCall(
    `public.claim_booking_reminder_delivery('${salon}','${booking}',` +
      `'${start}','${reminderType}','sms')`,
  );
}

async function complete(claimId, sid) {
  return serviceCall(
    `public.complete_booking_reminder_delivery('${claimId}','sent','${sid}',null)`,
  );
}

async function receipt(sid, status, errorCode = null) {
  return serviceCall(
    `public.record_twilio_message_status_receipt('${sid}','${status}',` +
      `${errorCode === null ? "null" : `'${errorCode}'`})`,
  );
}

async function cleanup() {
  await sql(`
    DELETE FROM public.twilio_message_status_receipts
      WHERE message_sid IN (
        '${sids.replay}','${sids.completionRace}','${sids.conflict}',
        '${sids.genericRace}','${sids.staffRace}','${sids.reviewRace}'
      );
    DELETE FROM public.staff_action_notification_outbox WHERE id='${staffOutbox}';
    DELETE FROM public.booking_notifications WHERE id='${genericNotification}';
    DELETE FROM public.booking_notifications WHERE id='${reviewNotification}';
    DELETE FROM public.salons WHERE id='${salon}';
    DELETE FROM public.service_categories WHERE slug='twilio-receipt-concurrency-qa';
  `);
}

try {
  await cleanup();
  await sql(`
    INSERT INTO public.service_categories(slug,name_en,name_vi)
    VALUES('twilio-receipt-concurrency-qa','Twilio receipt concurrency','Twilio receipt concurrency');
    INSERT INTO public.salons(id,slug,name,phone,timezone,is_beta)
    VALUES('${salon}','twilio-receipt-concurrency-qa','Twilio Receipt Concurrency QA','+16045551021','UTC',true);
    INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
    VALUES('${service}','${salon}','Receipt service',2500,30,'twilio-receipt-concurrency-qa');
    INSERT INTO public.staff(id,salon_id,name,status)
    VALUES('${staff}','${salon}','Receipt staff','active');
    INSERT INTO public.bookings(
      id,salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,price_cents
    ) VALUES (
      '${booking}','${salon}','${service}','${staff}','Receipt Fixture',
      '+16045551022','${start}','2026-08-25T19:30:00Z','confirmed',2500
    );
  `);

  const replayClaim = await claim("24h");
  assert.equal(replayClaim.code, "claimed");
  assert.equal((await complete(replayClaim.claim_id, sids.replay)).code, "completed");
  const replayResults = await Promise.all([
    receipt(sids.replay, "delivered"),
    receipt(sids.replay, "delivered"),
  ]);
  assert.deepEqual(
    replayResults.map((value) => value.code).sort(),
    ["applied", "exact_replay"],
  );
  assert.equal(
    await sql(`SELECT count(*) FROM public.twilio_message_status_receipts
      WHERE message_sid='${sids.replay}' AND applied_at IS NOT NULL`),
    "1",
  );
  assert.equal(
    await sql(`SELECT count(*) FROM public.booking_notifications
      WHERE twilio_message_sid='${sids.replay}' AND status='delivered'
        AND delivered_at IS NOT NULL AND failed_at IS NULL`),
    "1",
  );

  const raceClaim = await claim("3h");
  assert.equal(raceClaim.code, "claimed");
  const raceResults = await Promise.all([
    complete(raceClaim.claim_id, sids.completionRace),
    receipt(sids.completionRace, "delivered"),
  ]);
  assert(raceResults.some((value) => value.code === "completed"));
  assert(
    raceResults.some((value) => ["pending", "applied", "exact_replay"].includes(value.code)),
  );
  assert.equal(
    await sql(`SELECT count(*) FROM public.twilio_message_status_receipts r
      JOIN public.booking_notifications n ON n.id=r.notification_id
      JOIN public.booking_reminder_delivery_claims c ON c.id=r.reminder_claim_id
      WHERE r.message_sid='${sids.completionRace}' AND r.applied_at IS NOT NULL
        AND n.status='delivered' AND n.delivered_at IS NOT NULL AND n.failed_at IS NULL
        AND c.status='sent' AND c.delivery_status='delivered'`),
    "1",
  );

  await sql(`
    INSERT INTO public.booking_notifications(
      booking_id,salon_id,notification_type,channel,status,twilio_message_sid,sent_at
    ) VALUES (
      '${booking}','${salon}','reminder_24h','sms','sent','${sids.conflict}',transaction_timestamp()
    );
  `);
  const conflictResults = await Promise.all([
    receipt(sids.conflict, "delivered"),
    receipt(sids.conflict, "failed", "30003"),
  ]);
  assert.deepEqual(
    conflictResults.map((value) => value.code).sort(),
    ["applied", "durable_conflict"],
  );
  assert.equal(
    await sql(`SELECT count(*) FROM public.twilio_message_status_receipts r
      JOIN public.booking_notifications n ON n.id=r.notification_id
      WHERE r.message_sid='${sids.conflict}'
        AND r.conflict_status IS NOT NULL AND r.conflict_fingerprint IS NOT NULL
        AND n.status=r.terminal_status
        AND ((n.status='delivered' AND n.delivered_at IS NOT NULL AND n.failed_at IS NULL AND n.error_code IS NULL)
          OR (n.status='failed' AND n.delivered_at IS NULL AND n.failed_at IS NOT NULL AND n.error_code='30003'))`),
    "1",
  );

  await sql(`INSERT INTO public.booking_notifications(
      id,booking_id,salon_id,notification_type,channel,status
    ) VALUES (
      '${genericNotification}','${booking}','${salon}','review_request','sms','sending'
    )`);
  const genericRaceResults = await Promise.all([
    receipt(sids.genericRace, "delivered"),
    sql(`UPDATE public.booking_notifications SET status='sent',
      twilio_message_sid='${sids.genericRace}',sent_at=transaction_timestamp()
      WHERE id='${genericNotification}'`),
  ]);
  assert(
    ["pending", "applied", "exact_replay"].includes(genericRaceResults[0].code),
  );
  assert.equal(
    await sql(`SELECT count(*) FROM public.twilio_message_status_receipts r
      JOIN public.booking_notifications n ON n.id=r.notification_id
      WHERE r.message_sid='${sids.genericRace}' AND r.applied_at IS NOT NULL
        AND n.id='${genericNotification}' AND n.status='delivered'
        AND n.delivered_at IS NOT NULL AND n.failed_at IS NULL`),
    "1",
  );

  await sql(`
    INSERT INTO public.staff_action_notification_outbox(
      id,salon_id,booking_id,request_id,event_type,occurrence_version,
      actor_user_id,actor_role,requested_channels,result_snapshot,
      material_snapshot,material_fingerprint,notification_delay_seconds,
      send_after,expires_at,status
    ) VALUES (
      '${staffOutbox}','${salon}','${booking}','${staffRequest}','create',1,
      null,'system','{"sms":true,"email":false}'::jsonb,'{}'::jsonb,
      null,repeat('a',64),0,transaction_timestamp(),
      transaction_timestamp()+interval '20 minutes','active'
    );
    INSERT INTO public.staff_action_notification_deliveries(
      id,outbox_id,salon_id,booking_id,channel,status,attempt_count,
      attempt_token,payload_fingerprint,recipient_fingerprint,claimed_at,
      provider_name
    ) VALUES (
      '${staffDelivery}','${staffOutbox}','${salon}','${booking}',
      'sms','sending',1,'${staffAttempt}',repeat('b',64),repeat('c',64),
      transaction_timestamp(),'twilio'
    );
  `);
  const staffRaceResults = await Promise.all([
    receipt(sids.staffRace, "failed", "30003"),
    serviceCall(
      `public.complete_staff_action_notification_delivery(` +
        `'${staffDelivery}','${staffAttempt}','sent','${sids.staffRace}',null,'none')`,
    ),
  ]);
  assert(
    ["pending", "applied", "exact_replay"].includes(staffRaceResults[0].code),
  );
  assert.equal(staffRaceResults[1].code, "completed");
  assert.equal(
    await sql(`SELECT count(*) FROM public.twilio_message_status_receipts r
      JOIN public.staff_action_notification_deliveries d
        ON d.id=r.staff_action_delivery_id
      WHERE r.message_sid='${sids.staffRace}' AND r.applied_at IS NOT NULL
        AND d.id='${staffDelivery}' AND d.status='sent'
        AND d.delivery_status='failed' AND d.delivery_error_code='30003'
        AND d.delivery_received_at IS NOT NULL`),
    "1",
  );

  await sql(`INSERT INTO public.booking_notifications(
      id,booking_id,salon_id,notification_type,channel,status
    ) VALUES (
      '${reviewNotification}','${booking}','${salon}',
      'review_request','sms','sending'
    )`);
  const reviewRaceResults = await Promise.all([
    serviceCall(
      `public.record_twilio_review_request_status_receipt(` +
        `'${reviewNotification}','${sids.reviewRace}','delivered',null)`,
    ),
    serviceCall(
      `public.complete_review_request_sms_notification(` +
        `'${reviewNotification}','sent','${sids.reviewRace}',null)`,
    ),
  ]);
  assert(
    reviewRaceResults.some((value) => value.code === "applied"),
  );
  assert(
    reviewRaceResults.some((value) =>
      ["completed", "callback_terminal"].includes(value.code)),
  );
  assert.equal(
    await sql(`SELECT count(*) FROM public.twilio_message_status_receipts r
      JOIN public.booking_notifications n ON n.id=r.notification_id
      WHERE r.message_sid='${sids.reviewRace}' AND r.applied_at IS NOT NULL
        AND n.id='${reviewNotification}' AND n.status='delivered'
        AND n.delivered_at IS NOT NULL AND n.failed_at IS NULL`),
    "1",
  );

  process.stdout.write("PASS Twilio status receipt concurrency\n");
} finally {
  await cleanup();
}
