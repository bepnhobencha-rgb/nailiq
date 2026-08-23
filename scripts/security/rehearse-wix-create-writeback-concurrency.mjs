#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dbUrl = process.env.DB_URL;
const psql = process.env.PSQL_BIN ?? "psql";
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !dbUrl) {
  throw new Error("Refusing to run without a disposable local database");
}
const host = new URL(dbUrl).hostname;
if (!["", "localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-local database host: ${host}`);
}

const run = async (sql) => {
  const { stdout } = await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim().split("\n").at(-1)?.trim() ?? "";
};
const ids = {
  salon: "61280000-0000-4000-8000-000000000001",
  service: "61280000-0000-4000-8000-000000000002",
  staff: "61280000-0000-4000-8000-000000000003",
  booking: "61280000-0000-4000-8000-000000000004",
};
const category = "wix-writeback-concurrency";
const serviceCall = (body) => `
  select set_config('request.jwt.claim.role','service_role',true);
  ${body}
`;
const cleanup = () => run(`
  delete from public.wix_webhook_event_inbox where salon_id='${ids.salon}';
  delete from public.wix_lifecycle_writeback_operations where salon_id='${ids.salon}';
  delete from public.wix_create_writeback_operations where salon_id='${ids.salon}';
  delete from public.salons where id='${ids.salon}';
  delete from public.service_categories where slug='${category}';
`);

try {
  await cleanup();
  await run(`
    insert into public.service_categories(slug,name_en,name_vi)
      values('${category}','Wix writeback concurrency','Wix writeback concurrency');
    insert into public.salons(id,slug,name,phone,timezone,currency_code)
      values('${ids.salon}','${category}','Wix writeback concurrency','+16045550628','UTC','CAD');
    insert into public.services(
      id,salon_id,name,price_cents,duration_minutes,category,wix_service_id,wix_schedule_id
    ) values(
      '${ids.service}','${ids.salon}','Wix concurrency service',5000,30,'${category}',
      'wix-service-6128','wix-schedule-6128'
    );
    insert into public.staff(id,salon_id,name,wix_resource_id)
      values('${ids.staff}','${ids.salon}','Wix concurrency staff','wix-resource-6128');
    insert into public.wix_integrations(salon_id,site_id,enabled,wix_default_resource_id)
      values('${ids.salon}','wix-site-6128',true,'wix-resource-6128');
    insert into public.bookings(
      id,salon_id,service_id,staff_id,client_name,start_time_utc,end_time_utc,
      status,booking_channel,idempotency_key
    ) values(
      '${ids.booking}','${ids.salon}','${ids.service}','${ids.staff}',
      'Wix concurrency client',date_trunc('hour',now())+interval '2 days',
      date_trunc('hour',now())+interval '2 days 30 minutes','confirmed','online','${ids.booking}'
    );
  `);

  const claimSql = serviceCall(`
    select public.claim_wix_create_writeback('${ids.salon}','${ids.booking}')::text;
  `);
  const initial = (await Promise.all(Array.from({ length: 8 }, () => run(claimSql))))
    .map((value) => JSON.parse(value));
  assert.equal(initial.filter((row) => row.code === "operation_claimed").length, 1);
  assert.equal(initial.filter((row) => row.code === "operation_in_flight").length, 7);
  assert.equal(new Set(initial.map((row) => row.operation_id)).size, 1);
  assert.equal(await run(`select count(*) from public.wix_create_writeback_operations where booking_id='${ids.booking}'`), "1");

  const first = initial.find((row) => row.code === "operation_claimed");
  await run(serviceCall(`
    select public.complete_wix_create_writeback(
      '${first.operation_id}','${first.attempt_token}','unknown',null,null,repeat('a',64),
      'simulated_response_loss'
    );
  `));
  await run(`update public.wix_create_writeback_operations set next_reconcile_at=now()-interval '1 second' where id='${first.operation_id}'`);

  const reconciliation = (await Promise.all(Array.from({ length: 8 }, () => run(claimSql))))
    .map((value) => JSON.parse(value));
  assert.equal(reconciliation.filter((row) => row.code === "reconciliation_claimed").length, 1);
  assert.equal(reconciliation.filter((row) => row.code === "operation_in_flight").length, 7);
  assert.equal(new Set(reconciliation.map((row) => row.operation_id)).size, 1);

  const winner = reconciliation.find((row) => row.code === "reconciliation_claimed");
  const completed = JSON.parse(await run(serviceCall(`
    select public.complete_wix_create_writeback(
      '${winner.operation_id}','${winner.attempt_token}','succeeded',
      'wix-booking-6128','12',repeat('b',64),null
    )::text;
  `)));
  assert.equal(completed.status, "succeeded");
  assert.equal(
    await run(`select wix_booking_id||':'||attempt_count::text from public.bookings b join public.wix_create_writeback_operations o on o.booking_id=b.id where b.id='${ids.booking}'`),
    "wix-booking-6128:2",
  );

  const lifecycleClaim = serviceCall(`
    select public.claim_wix_lifecycle_writeback('${ids.salon}','${ids.booking}','confirm')::text;
  `);
  const lifecycleInitial = (await Promise.all(Array.from({ length: 8 }, () => run(lifecycleClaim))))
    .map((value) => JSON.parse(value));
  assert.equal(lifecycleInitial.filter((row) => row.code === "operation_claimed").length, 1);
  assert.equal(lifecycleInitial.filter((row) => row.code === "operation_in_flight").length, 7);
  const lifecycleFirst = lifecycleInitial.find((row) => row.code === "operation_claimed");
  await run(serviceCall(`
    select public.complete_wix_lifecycle_writeback(
      '${lifecycleFirst.operation_id}','${lifecycleFirst.attempt_token}','unknown','1',repeat('c',64),
      'simulated_lifecycle_response_loss'
    );
  `));
  await run(`update public.wix_lifecycle_writeback_operations set next_reconcile_at=now()-interval '1 second' where id='${lifecycleFirst.operation_id}'`);
  const lifecycleReconciliation = (await Promise.all(Array.from({ length: 8 }, () => run(lifecycleClaim))))
    .map((value) => JSON.parse(value));
  assert.equal(lifecycleReconciliation.filter((row) => row.code === "reconciliation_claimed").length, 1);
  assert.equal(lifecycleReconciliation.filter((row) => row.code === "operation_in_flight").length, 7);
  const lifecycleWinner = lifecycleReconciliation.find((row) => row.code === "reconciliation_claimed");
  await run(serviceCall(`
    select public.complete_wix_lifecycle_writeback(
      '${lifecycleWinner.operation_id}','${lifecycleWinner.attempt_token}','succeeded','2',repeat('d',64),null
    );
  `));
  assert.equal(
    await run(`select status||':'||attempt_count::text from public.wix_lifecycle_writeback_operations where id='${lifecycleWinner.operation_id}'`),
    "succeeded:2",
  );

  const webhookRecord = serviceCall(`
    select public.record_wix_webhook_event(
      '${ids.salon}','wix-site-6128','wix-event-race-6128','wix-booking-6128',
      'updated','2026-08-22T18:00:00Z',repeat('e',64)
    )::text;
  `);
  const webhookRows = (await Promise.all(Array.from({ length: 8 }, () => run(webhookRecord))))
    .map((value) => JSON.parse(value));
  assert.equal(webhookRows.filter((row) => row.code === "event_recorded").length, 1);
  assert.equal(webhookRows.filter((row) => row.code === "event_replay").length, 7);
  const inboxId = webhookRows[0].inbox_id;
  const webhookClaim = serviceCall(`select public.claim_wix_webhook_event('${inboxId}')::text;`);
  const webhookClaims = (await Promise.all(Array.from({ length: 8 }, () => run(webhookClaim))))
    .map((value) => JSON.parse(value));
  assert.equal(webhookClaims.filter((row) => row.code === "event_claimed").length, 1);
  assert.equal(webhookClaims.filter((row) => row.code === "event_in_flight").length, 7);
  assert.equal(await run(`select count(*) from public.wix_webhook_event_inbox where id='${inboxId}'`), "1");
  console.log("wix create writeback concurrency passed");
} finally {
  await cleanup();
}
