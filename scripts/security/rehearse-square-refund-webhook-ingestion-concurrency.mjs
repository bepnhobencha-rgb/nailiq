#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  canonicalLocalDatabaseUrl,
  readLocalStackIdentity,
  runSupabaseStatus,
} from "./local-supabase-status.mjs";

const run = promisify(execFile);
const configuredDbUrl = process.env.DB_URL;
const psql = process.env.PSQL_BIN ?? "psql";
const applyMigration = process.env.MQA0126_APPLY_MIGRATION === "1";
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !configuredDbUrl) {
  throw new Error("NAILIQ_DISPOSABLE_DB=1 and a disposable local DB_URL are required");
}
const stack = readLocalStackIdentity(process.cwd(), "MQA-0126 local stack");
if (stack.projectId !== "nailiq-e2e-local") {
  throw new Error(`unexpected Supabase project_id ${stack.projectId}`);
}
const localStatus = runSupabaseStatus(stack);
if (
  canonicalLocalDatabaseUrl(configuredDbUrl, "MQA-0126 configured DB_URL")
  !== canonicalLocalDatabaseUrl(localStatus.dbUrl, "MQA-0126 status DB_URL")
) {
  throw new Error("MQA-0126 DB_URL does not match independent local Supabase status");
}
const dbUrl = localStatus.dbUrl;
const parsedDbUrl = new URL(dbUrl);
if (
  !["postgres:", "postgresql:"].includes(parsedDbUrl.protocol)
  || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsedDbUrl.hostname)
) {
  throw new Error(`refusing non-local database ${parsedDbUrl.hostname}`);
}

const childEnv = {
  PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  PGCONNECT_TIMEOUT: "3",
};
async function psqlRun(args, timeout = 30_000) {
  return run(psql, [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    env: childEnv,
    timeout,
    maxBuffer: 8e6,
  });
}
async function sql(query) {
  const { stdout } = await psqlRun(["-Atq", "-c", query]);
  return stdout.trim();
}
function json(output) {
  const line = output.split("\n").findLast((value) => value.startsWith("{"));
  return line ? JSON.parse(line) : null;
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const permissionDenied = (error) => /permission denied/i.test(
  String(error?.stderr ?? error?.message ?? error),
);

const ids = {
  salonA: "12600000-0000-4000-8000-000000000001",
  serviceA: "12600000-0000-4000-8000-000000000002",
  staffA: "12600000-0000-4000-8000-000000000003",
  bookingA: "12600000-0000-4000-8000-000000000010",
  partialOp: "12600000-0000-4000-8000-000000000011",
  remainingOp: "12600000-0000-4000-8000-000000000012",
  bookingConcurrent: "12600000-0000-4000-8000-000000000020",
  concurrentOpA: "12600000-0000-4000-8000-000000000021",
  concurrentOpB: "12600000-0000-4000-8000-000000000022",
  bookingRetry: "12600000-0000-4000-8000-000000000030",
  retryOp: "12600000-0000-4000-8000-000000000031",
  salonB: "12600000-0000-4000-8000-000000000101",
  serviceB: "12600000-0000-4000-8000-000000000102",
  staffB: "12600000-0000-4000-8000-000000000103",
};
const accountA = {
  merchant: "merchant-mqa0126-a",
  location: "location-mqa0126-a",
  application: "application-mqa0126-a",
  environment: "sandbox",
};
const accountB = {
  merchant: "merchant-mqa0126-b",
  location: "location-mqa0126-b",
  application: "application-mqa0126-b",
  environment: "sandbox",
};
const fingerprint = (account) => sha256(
  `square:${account.merchant}:${account.location}:${account.environment}`,
);
let ownsSchema = false;

async function cleanupRows() {
  await sql(`
    BEGIN;
    SELECT set_config('request.jwt.claim.role','service_role',true);
    DELETE FROM public.square_refund_webhook_inbox
      WHERE salon_id IN ('${ids.salonA}','${ids.salonB}');
    DELETE FROM public.booking_payment_operations
      WHERE salon_id IN ('${ids.salonA}','${ids.salonB}');
    DELETE FROM public.bookings
      WHERE salon_id IN ('${ids.salonA}','${ids.salonB}');
    DELETE FROM public.square_integrations
      WHERE salon_id IN ('${ids.salonA}','${ids.salonB}');
    DELETE FROM public.staff
      WHERE salon_id IN ('${ids.salonA}','${ids.salonB}');
    DELETE FROM public.services
      WHERE salon_id IN ('${ids.salonA}','${ids.salonB}');
    DELETE FROM public.salons
      WHERE id IN ('${ids.salonA}','${ids.salonB}');
    DELETE FROM public.service_categories WHERE slug='mqa0126-refund-webhook';
    COMMIT;
  `);
}

async function teardownOwnedSchema() {
  await sql(`
    DROP FUNCTION IF EXISTS public.record_square_refund_webhook_event(
      uuid,text,timestamptz,text,text,text,text,text,integer,text,
      timestamptz,text,text,text
    );
    DROP TABLE IF EXISTS public.square_refund_webhook_inbox;
  `);
}

function callRefund({
  salon = ids.salonA,
  account = accountA,
  eventId,
  payload = eventId,
  refundId,
  paymentId,
  status,
  amount,
  occurredAt,
  updatedAt,
}) {
  return sql(`
    BEGIN;
    SET LOCAL ROLE service_role;
    SELECT set_config('request.jwt.claim.role','service_role',true);
    SELECT public.record_square_refund_webhook_event(
      '${salon}','${eventId}','${occurredAt}','${sha256(payload)}',
      '${refundId}','${paymentId}','${account.location}','${status}',${amount},
      'CAD','${updatedAt}','${account.merchant}','${account.application}',
      '${account.environment}'
    )::text;
    COMMIT;
  `).then(json);
}

try {
  const exists = await sql(
    "SELECT to_regclass('public.square_refund_webhook_inbox') IS NOT NULL",
  );
  if (applyMigration) {
    assert.equal(exists, "f", "refusing to replace an already-applied MQA-0126 schema");
    const migration = fileURLToPath(new URL(
      "../../supabase/migrations/20260823110412_add_durable_square_refund_webhook_ingestion.sql",
      import.meta.url,
    ));
    await psqlRun(["--single-transaction", "-f", migration]);
    ownsSchema = true;
  } else {
    assert.equal(exists, "t", "apply the MQA-0126 migration or set MQA0126_APPLY_MIGRATION=1");
  }

  await assert.rejects(
    sql(`BEGIN; SET LOCAL ROLE service_role;
      SELECT count(*) FROM public.square_refund_webhook_inbox; ROLLBACK;`),
    permissionDenied,
  );
  const missingClaim = json(await sql(`
    BEGIN;
    SET LOCAL ROLE service_role;
    SELECT public.record_square_refund_webhook_event(
      '${ids.salonA}','claim-event','2026-08-23T17:00:00Z',repeat('b',64),
      'claim-refund','claim-payment','claim-location','PENDING',1,'CAD',
      '2026-08-23T17:00:00Z','claim-merchant','claim-application','sandbox'
    )::text;
    ROLLBACK;
  `));
  assert.equal(missingClaim.code, "unauthorized", JSON.stringify(missingClaim));

  await cleanupRows();
  const material = (account) => JSON.stringify({
    provider: "square",
    provider_account_id: account.merchant,
    provider_location_id: account.location,
    provider_application_id: account.application,
    provider_environment: account.environment,
    currency: "CAD",
  }).replaceAll("'", "''");
  await sql(`
    INSERT INTO public.service_categories(slug,name_en,name_vi)
    VALUES('mqa0126-refund-webhook','MQA 0126 refund','MQA 0126 refund');
    INSERT INTO public.salons(
      id,slug,name,phone,timezone,currency_code,payment_provider
    ) VALUES
      ('${ids.salonA}','mqa0126-refund-a','MQA 0126 refund A',
       '+16045551260','UTC','CAD','square'),
      ('${ids.salonB}','mqa0126-refund-b','MQA 0126 refund B',
       '+16045551261','UTC','CAD','square');
    INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
    VALUES
      ('${ids.serviceA}','${ids.salonA}','Refund A',5000,30,'mqa0126-refund-webhook'),
      ('${ids.serviceB}','${ids.salonB}','Refund B',5000,30,'mqa0126-refund-webhook');
    INSERT INTO public.staff(id,salon_id,name,status) VALUES
      ('${ids.staffA}','${ids.salonA}','Refund A','active'),
      ('${ids.staffB}','${ids.salonB}','Refund B','active');
    INSERT INTO public.square_integrations(
      salon_id,merchant_id,location_id,access_token,enabled,deposit_enabled,
      deposit_percent,deposit_risk_threshold,application_id,environment
    ) VALUES
      ('${ids.salonA}','${accountA.merchant}','${accountA.location}',
       'fake-local-token-a',true,true,20,0,'${accountA.application}','sandbox'),
      ('${ids.salonB}','${accountB.merchant}','${accountB.location}',
       'fake-local-token-b',true,true,20,0,'${accountB.application}','sandbox');
    INSERT INTO public.bookings(
      id,salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,deposit_required,deposit_amount_cents,
      deposit_status,deposit_paid_at,square_payment_id,deposit_refunded_cents,
      deposit_refund_status,deposit_payment_ledger_enforced_at
    ) VALUES
      ('${ids.bookingA}','${ids.salonA}','${ids.serviceA}','${ids.staffA}',
       'Refund sequence','+16045551262',clock_timestamp()+interval '1 day',
       clock_timestamp()+interval '1 day 30 minutes','confirmed',true,5000,
       'paid',clock_timestamp(),'payment-mqa0126-a',0,'none',clock_timestamp()),
      ('${ids.bookingConcurrent}','${ids.salonA}','${ids.serviceA}','${ids.staffA}',
       'Refund concurrency','+16045551263',clock_timestamp()+interval '2 days',
       clock_timestamp()+interval '2 days 30 minutes','confirmed',true,5000,
       'paid',clock_timestamp(),'payment-mqa0126-concurrent',0,'none',clock_timestamp()),
      ('${ids.bookingRetry}','${ids.salonA}','${ids.serviceA}','${ids.staffA}',
       'Refund late operation','+16045551264',clock_timestamp()+interval '3 days',
       clock_timestamp()+interval '3 days 30 minutes','confirmed',true,500,
       'paid',clock_timestamp(),'payment-mqa0126-retry',0,'none',clock_timestamp());
    INSERT INTO public.booking_payment_operations(
      id,salon_id,booking_id,request_id,operation_kind,provider,
      provider_account_fingerprint,amount_cents,currency,material_fingerprint,
      material_json,provider_material,parent_payment_id,provider_refund_id,
      provider_status,provider_idempotency_key,status,next_reconcile_at
    ) VALUES
      ('${ids.partialOp}','${ids.salonA}','${ids.bookingA}',gen_random_uuid(),
       'deposit_refund','square','${fingerprint(accountA)}',2000,'CAD',repeat('1',64),
       '{"captured_cents":5000}'::jsonb,'${material(accountA)}'::jsonb,
       'payment-mqa0126-a','refund-mqa0126-partial','PENDING',
       'nq:${ids.partialOp}','pending_provider',clock_timestamp()),
      ('${ids.remainingOp}','${ids.salonA}','${ids.bookingA}',gen_random_uuid(),
       'deposit_refund','square','${fingerprint(accountA)}',3000,'CAD',repeat('2',64),
       '{"captured_cents":5000}'::jsonb,'${material(accountA)}'::jsonb,
       'payment-mqa0126-a','refund-mqa0126-remaining','PENDING',
       'nq:${ids.remainingOp}','unknown',clock_timestamp()),
      ('${ids.concurrentOpA}','${ids.salonA}','${ids.bookingConcurrent}',gen_random_uuid(),
       'deposit_refund','square','${fingerprint(accountA)}',2000,'CAD',repeat('3',64),
       '{"captured_cents":5000}'::jsonb,'${material(accountA)}'::jsonb,
       'payment-mqa0126-concurrent','refund-mqa0126-concurrent-a','PENDING',
       'nq:${ids.concurrentOpA}','pending_provider',clock_timestamp()),
      ('${ids.concurrentOpB}','${ids.salonA}','${ids.bookingConcurrent}',gen_random_uuid(),
       'deposit_refund','square','${fingerprint(accountA)}',3000,'CAD',repeat('4',64),
       '{"captured_cents":5000}'::jsonb,'${material(accountA)}'::jsonb,
       'payment-mqa0126-concurrent','refund-mqa0126-concurrent-b','PENDING',
       'nq:${ids.concurrentOpB}','pending_provider',clock_timestamp());
  `);

  const retryInput = {
    eventId: "event-mqa0126-operation-retry",
    refundId: "refund-mqa0126-operation-retry",
    paymentId: "payment-mqa0126-retry",
    status: "COMPLETED",
    amount: 500,
    occurredAt: "2026-08-23T17:58:01Z",
    updatedAt: "2026-08-23T17:58:00Z",
  };
  const missingOperation = await callRefund(retryInput);
  assert.equal(missingOperation.code, "operation_not_found", JSON.stringify(missingOperation));
  await sql(`
    INSERT INTO public.booking_payment_operations(
      id,salon_id,booking_id,request_id,operation_kind,provider,
      provider_account_fingerprint,amount_cents,currency,material_fingerprint,
      material_json,provider_material,parent_payment_id,provider_refund_id,
      provider_status,provider_idempotency_key,status,next_reconcile_at
    ) VALUES (
      '${ids.retryOp}','${ids.salonA}','${ids.bookingRetry}',gen_random_uuid(),
      'deposit_refund','square','${fingerprint(accountA)}',500,'CAD',repeat('5',64),
      '{"captured_cents":500}'::jsonb,'${material(accountA)}'::jsonb,
      'payment-mqa0126-retry','refund-mqa0126-operation-retry','PENDING',
      'nq:${ids.retryOp}','pending_provider',clock_timestamp()
    );
  `);
  const recoveredOperation = await callRefund(retryInput);
  const recoveredReplay = await callRefund(retryInput);
  assert.equal(recoveredOperation.code, "refund_applied", JSON.stringify(recoveredOperation));
  assert.equal(recoveredReplay.code, "event_replay", JSON.stringify(recoveredReplay));
  assert.equal(
    await sql(`SELECT deposit_refunded_cents||':'||deposit_refund_status||':'||deposit_status
      FROM public.bookings WHERE id='${ids.bookingRetry}'`),
    "500:full:refunded",
  );

  const pendingInput = {
    eventId: "event-mqa0126-partial-pending",
    refundId: "refund-mqa0126-partial",
    paymentId: "payment-mqa0126-a",
    status: "PENDING",
    amount: 2000,
    occurredAt: "2026-08-23T18:00:01Z",
    updatedAt: "2026-08-23T18:00:00Z",
  };
  const pendingRace = await Promise.all([
    callRefund(pendingInput),
    callRefund(pendingInput),
  ]);
  assert.deepEqual(
    pendingRace.map((result) => result.code).sort(),
    ["event_replay", "refund_pending"],
    JSON.stringify(pendingRace),
  );

  const conflictingDuplicate = await callRefund({
    ...pendingInput,
    payload: "conflicting-payload",
    amount: 1999,
  });
  assert.equal(conflictingDuplicate.code, "event_conflict");

  const partialComplete = await callRefund({
    eventId: "event-mqa0126-partial-completed",
    refundId: "refund-mqa0126-partial",
    paymentId: "payment-mqa0126-a",
    status: "COMPLETED",
    amount: 2000,
    occurredAt: "2026-08-23T18:01:01Z",
    updatedAt: "2026-08-23T18:01:00Z",
  });
  assert.equal(partialComplete.code, "refund_applied", JSON.stringify(partialComplete));
  assert.equal(
    await sql(`SELECT deposit_refunded_cents||':'||deposit_refund_status
      FROM public.bookings WHERE id='${ids.bookingA}'`),
    "2000:partial",
  );

  const remainingInput = {
    eventId: "event-mqa0126-remaining-completed",
    refundId: "refund-mqa0126-remaining",
    paymentId: "payment-mqa0126-a",
    status: "COMPLETED",
    amount: 3000,
    occurredAt: "2026-08-23T18:02:01Z",
    updatedAt: "2026-08-23T18:02:00Z",
  };
  const remaining = await callRefund(remainingInput);
  const remainingReplay = await callRefund(remainingInput);
  assert.equal(remaining.code, "refund_applied", JSON.stringify(remaining));
  assert.equal(remainingReplay.code, "event_replay", JSON.stringify(remainingReplay));
  assert.equal(
    await sql(`SELECT deposit_refunded_cents||':'||deposit_refund_status||':'||deposit_status
      FROM public.bookings WHERE id='${ids.bookingA}'`),
    "5000:full:refunded",
  );

  const stalePending = await callRefund({
    ...pendingInput,
    eventId: "event-mqa0126-partial-stale",
    payload: "stale-pending",
    occurredAt: "2026-08-23T18:03:00Z",
    updatedAt: "2026-08-23T17:59:59Z",
  });
  assert.equal(stalePending.code, "stale_event_ignored", JSON.stringify(stalePending));
  assert.equal(
    await sql(`SELECT status FROM public.booking_payment_operations
      WHERE id='${ids.partialOp}'`),
    "succeeded",
  );

  const concurrentResults = await Promise.all([
    callRefund({
      eventId: "event-mqa0126-concurrent-a",
      refundId: "refund-mqa0126-concurrent-a",
      paymentId: "payment-mqa0126-concurrent",
      status: "COMPLETED",
      amount: 2000,
      occurredAt: "2026-08-23T18:04:01Z",
      updatedAt: "2026-08-23T18:04:00Z",
    }),
    callRefund({
      eventId: "event-mqa0126-concurrent-b",
      refundId: "refund-mqa0126-concurrent-b",
      paymentId: "payment-mqa0126-concurrent",
      status: "COMPLETED",
      amount: 3000,
      occurredAt: "2026-08-23T18:04:02Z",
      updatedAt: "2026-08-23T18:04:01Z",
    }),
  ]);
  assert.deepEqual(
    concurrentResults.map((result) => result.code),
    ["refund_applied", "refund_applied"],
    JSON.stringify(concurrentResults),
  );
  assert.equal(
    await sql(`SELECT deposit_refunded_cents||':'||deposit_refund_status
      FROM public.bookings WHERE id='${ids.bookingConcurrent}'`),
    "5000:full",
  );

  const hostileTenant = await callRefund({
    salon: ids.salonB,
    account: accountB,
    eventId: "event-mqa0126-hostile-tenant",
    refundId: "refund-mqa0126-partial",
    paymentId: "payment-mqa0126-a",
    status: "COMPLETED",
    amount: 2000,
    occurredAt: "2026-08-23T18:05:01Z",
    updatedAt: "2026-08-23T18:05:00Z",
  });
  assert.equal(hostileTenant.code, "operation_not_found", JSON.stringify(hostileTenant));
  const hostileAccount = await callRefund({
    salon: ids.salonB,
    account: accountA,
    eventId: "event-mqa0126-hostile-account",
    refundId: "refund-mqa0126-partial",
    paymentId: "payment-mqa0126-a",
    status: "COMPLETED",
    amount: 2000,
    occurredAt: "2026-08-23T18:06:01Z",
    updatedAt: "2026-08-23T18:06:00Z",
  });
  assert.equal(hostileAccount.code, "provider_context_mismatch", JSON.stringify(hostileAccount));
  assert.equal(
    await sql(`SELECT count(*) FROM public.square_refund_webhook_inbox
      WHERE salon_id='${ids.salonB}'`),
    "1",
  );
  assert.equal(
    await sql(`SELECT deposit_refunded_cents FROM public.bookings
      WHERE id='${ids.bookingA}'`),
    "5000",
  );

  process.stdout.write(
    "PASS MQA-0126 durable refund webhook replay/concurrency/isolation\n",
  );
} finally {
  let cleanupError;
  const schemaExists = await sql(
    "SELECT to_regclass('public.square_refund_webhook_inbox') IS NOT NULL",
  ).catch(() => "f");
  if (schemaExists === "t") {
    try {
      await cleanupRows();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (ownsSchema) {
    try {
      await teardownOwnedSchema();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  const leftovers = await sql(`
    SELECT
      (SELECT count(*) FROM public.salons
       WHERE id IN ('${ids.salonA}','${ids.salonB}'))
      +
      (SELECT count(*) FROM public.service_categories
       WHERE slug='mqa0126-refund-webhook')
  `).catch(() => "cleanup_check_failed");
  if (leftovers !== "0") {
    cleanupError ??= new Error(`MQA-0126 cleanup incomplete: ${leftovers}`);
  }
  if (cleanupError) throw cleanupError;
}
