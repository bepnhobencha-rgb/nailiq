#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dbUrl = process.env.DB_URL;
const psql = process.env.PSQL_BIN ?? "psql";
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !dbUrl) {
  throw new Error("Refusing to run without NAILIQ_DISPOSABLE_DB=1 and DB_URL");
}
const parsed = new URL(dbUrl);
if (!["", "localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)) {
  throw new Error(`Refusing non-local database host: ${parsed.hostname}`);
}
const run = async (sql) => (await execFileAsync(
  psql,[dbUrl,"-X","-v","ON_ERROR_STOP=1","-Atq","-c",sql],
  { encoding:"utf8", timeout:30_000, maxBuffer:4*1024*1024 },
)).stdout.trim();
const ids = {
  salon:"f1130000-0000-4000-8000-000000000001",
  owner:"f1130000-0000-4000-8000-000000000002",
  service:"f1130000-0000-4000-8000-000000000003",
  booking:"f1130000-0000-4000-8000-000000000004",
  charge:"f1130000-0000-4000-8000-000000000005",
  refundA:"f1130000-0000-4000-8000-000000000006",
  refundB:"f1130000-0000-4000-8000-000000000007",
  refundC:"f1130000-0000-4000-8000-000000000008",
};
const cleanup = async () => run(`
  delete from public.salons where id='${ids.salon}';
  delete from auth.users where id='${ids.owner}';
  delete from public.service_categories where slug='financial-report-concurrency';
`);
try {
  await cleanup();
  await run(`
    insert into auth.users(id,email) values('${ids.owner}','financial-concurrency@example.test');
    insert into public.service_categories(slug,name_en,name_vi)
      values('financial-report-concurrency','Financial concurrency','Financial concurrency');
    insert into public.salons(id,slug,name,phone,timezone,currency_code)
      values('${ids.salon}','financial-report-concurrency','Financial concurrency',
        '+16045550131','UTC','CAD');
    insert into public.salon_members(salon_id,user_id,role)
      values('${ids.salon}','${ids.owner}','owner');
    insert into public.services(id,salon_id,name,price_cents,duration_minutes,category)
      values('${ids.service}','${ids.salon}','Financial concurrency',1000,30,
        'financial-report-concurrency');
    insert into public.bookings(id,salon_id,service_id,client_name,start_time_utc,
      end_time_utc,status)
      values('${ids.booking}','${ids.salon}','${ids.service}','Concurrency client',
        '2026-08-05Z','2026-08-05 00:30Z','completed');
    insert into public.booking_payment_operations(
      id,salon_id,booking_id,request_id,operation_kind,provider,
      provider_account_fingerprint,amount_cents,currency,material_fingerprint,
      material_json,provider_material,provider_payment_id,provider_idempotency_key,
      status,result_json,created_at,completed_at
    ) values('${ids.charge}','${ids.salon}','${ids.booking}',gen_random_uuid(),
      'deposit_charge','stripe',repeat('a',64),1000,'CAD',repeat('b',64),'{}','{}',
      'pi_financial_concurrency','nq:financial-concurrency-parent','succeeded',
      '{"provider_status":"succeeded"}','2026-07-01Z','2026-07-01 00:01Z');
  `);
  const refundSql = (id, suffix) => `insert into public.booking_payment_operations(
      id,salon_id,booking_id,request_id,operation_kind,provider,
      provider_account_fingerprint,amount_cents,currency,material_fingerprint,
      material_json,provider_material,parent_payment_id,parent_operation_id,
      provider_refund_id,provider_idempotency_key,status,result_json,created_at,completed_at
    ) values('${id}','${ids.salon}','${ids.booking}',gen_random_uuid(),
      'deposit_refund','stripe',repeat('a',64),200,'CAD',repeat('${suffix}',64),'{}','{}',
      'pi_financial_concurrency','${ids.charge}','re_financial_same',
      'nq:financial-concurrency-${suffix}','succeeded','{"provider_status":"succeeded"}',
      '2026-08-08Z','2026-08-08 00:01Z')`;
  const race = await Promise.allSettled([
    run(refundSql(ids.refundA,"c")),run(refundSql(ids.refundB,"d")),
  ]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length,1);
  assert.equal(race.filter((r) => r.status === "rejected").length,1);
  assert.equal(await run(`select count(*) from public.booking_payment_operations
    where provider_refund_id='re_financial_same'`),"1");

  // The report is one PostgreSQL statement snapshot. Commit a second partial
  // refund while the report statement is deliberately paused after its MVCC
  // snapshot is acquired: the result must be wholly before, then a subsequent
  // report wholly after, never mixed event/totals state.
  const reportJsonSql = `select set_config('request.jwt.claim.role','service_role',true);
    select public.load_authoritative_financial_report('${ids.salon}','${ids.owner}',
      '2026-08-01','2026-09-01','2026-08-20Z')::text`;
  const delayedInsert = run(`begin;
    ${refundSql(ids.refundC,"e").replaceAll("re_financial_same","re_financial_after_snapshot")};
    select pg_sleep(0.8); commit;`);
  await new Promise((resolve) => setTimeout(resolve,300));
  const duringRaw = run(`begin isolation level repeatable read;
    select count(*) from public.booking_payment_operations where salon_id='${ids.salon}';
    select pg_sleep(1.0);
    select set_config('request.jwt.claim.role','service_role',true);
    select public.load_authoritative_financial_report('${ids.salon}','${ids.owner}',
      '2026-08-01','2026-09-01','2026-08-20Z')::text;
    commit`);
  const [,duringOutput] = await Promise.all([delayedInsert,duringRaw]);
  const during = JSON.parse(duringOutput.split("\n").at(-1));
  const after = JSON.parse((await run(reportJsonSql)).split("\n").at(-1));
  assert.equal(during.operation_events.filter((event) => event.kind === "deposit_refund").length,1);
  assert.equal(during.totals.refund_cents,200);
  assert.equal(during.totals.collected_net_cents,-200);
  assert.equal(after.operation_events.filter((event) => event.kind === "deposit_refund").length,2);
  assert.equal(after.totals.refund_cents,400);
  assert.equal(after.totals.collected_net_cents,-400);

  const reportSql = `select set_config('request.jwt.claim.role','service_role',true);
    select public.load_authoritative_financial_report('${ids.salon}','${ids.owner}',
      '2026-08-01','2026-09-01','2026-08-20Z')->>'source_fingerprint'`;
  const [rawFingerprintA,rawFingerprintB] = await Promise.all([run(reportSql),run(reportSql)]);
  const fingerprintA = rawFingerprintA.split("\n").at(-1);
  const fingerprintB = rawFingerprintB.split("\n").at(-1);
  assert.match(fingerprintA,/^[0-9a-f]{64}$/);
  assert.equal(fingerprintA,fingerprintB);
  console.log("authoritative financial report concurrency passed");
} finally {
  await cleanup();
}
