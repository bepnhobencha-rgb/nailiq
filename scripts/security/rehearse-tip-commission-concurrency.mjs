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

const run = async (sql) => {
  const { stdout } = await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim().split("\n").at(-1)?.trim() ?? "";
};

const ids = {
  owner: "f1700000-0000-4000-8000-000000000001",
  salon: "f1700000-0000-4000-8000-000000000002",
  service: "f1700000-0000-4000-8000-000000000003",
  staff: "f1700000-0000-4000-8000-000000000004",
  booking: "f1700000-0000-4000-8000-000000000005",
};

const cleanup = () => run(`
  delete from public.salons where id='${ids.salon}';
  delete from auth.users where id='${ids.owner}';
  delete from public.service_categories where slug='mqa-compensation-concurrency';
`);
const serviceCall = (body) => `
  select set_config('request.jwt.claim.role','service_role',true);
  ${body}
`;

try {
  await cleanup();
  await run(`
    insert into auth.users(id,email,created_at)
      values('${ids.owner}','compensation-concurrency@nailiq.invalid',transaction_timestamp());
    insert into public.salons(id,slug,name,phone,timezone,currency_code)
      values('${ids.salon}','mqa-compensation-concurrency','MQA Compensation Concurrency','+16045550711','America/Vancouver','CAD');
    insert into public.salon_members(salon_id,user_id,role)
      values('${ids.salon}','${ids.owner}','owner');
    insert into public.service_categories(slug,name_en,name_vi)
      values('mqa-compensation-concurrency','MQA Compensation Concurrency','MQA Compensation Concurrency');
    insert into public.services(id,salon_id,name,duration_minutes,price_cents,category)
      values('${ids.service}','${ids.salon}','Concurrency Service',30,5000,'mqa-compensation-concurrency');
    insert into public.staff(id,salon_id,name,status)
      values('${ids.staff}','${ids.salon}','Concurrency Tech','active');
    insert into public.bookings(
      id,salon_id,service_id,staff_id,client_name,start_time_utc,end_time_utc,
      status,subtotal_cents,tax_amount_cents,price_cents
    ) values(
      '${ids.booking}','${ids.salon}','${ids.service}','${ids.staff}',
      'Concurrency Client','2026-08-22 14:00Z','2026-08-22 14:30Z',
      'completed',5000,0,5000
    );
  `);
  await run(serviceCall(`
    select public.configure_salon_financial_metric_policy(
      '${ids.salon}','${ids.owner}','tips',null,'2026-08-01 00:00Z',null
    );
    select public.configure_salon_financial_metric_policy(
      '${ids.salon}','${ids.owner}','commission',2000,'2026-08-01 00:00Z',null
    );
  `));

  const tipCall = serviceCall(`
    select (public.record_booking_tip_evidence(
      '${ids.salon}','${ids.booking}','${ids.owner}',1000,'CAD',
      'manual_verified','tip:concurrency:one',null
    )->>'applied')::text;
  `);
  const tipRace = await Promise.all([run(tipCall), run(tipCall)]);
  assert.deepEqual(tipRace.sort(), ["false", "true"]);

  const commissionCall = serviceCall(`
    select (public.calculate_booking_commission_evidence(
      '${ids.salon}','${ids.booking}','${ids.owner}','commission:concurrency:one'
    )->>'applied')::text;
  `);
  const commissionRace = await Promise.all([run(commissionCall), run(commissionCall)]);
  assert.deepEqual(commissionRace.sort(), ["false", "true"]);

  const reversalCall = serviceCall(`
    select (public.record_booking_financial_metric_reversal(
      '${ids.salon}','${ids.booking}','${ids.owner}','tips',200,
      'tip:concurrency:reversal',null
    )->>'applied')::text;
  `);
  const reversalRace = await Promise.all([run(reversalCall), run(reversalCall)]);
  assert.deepEqual(reversalRace.sort(), ["false", "true"]);

  const overA = serviceCall(`
    select public.record_booking_financial_metric_reversal(
      '${ids.salon}','${ids.booking}','${ids.owner}','tips',600,
      'tip:concurrency:over-a',null
    );
  `);
  const overB = serviceCall(`
    select public.record_booking_financial_metric_reversal(
      '${ids.salon}','${ids.booking}','${ids.owner}','tips',600,
      'tip:concurrency:over-b',null
    );
  `);
  const overRace = await Promise.allSettled([run(overA), run(overB)]);
  assert.equal(overRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(overRace.filter((result) => result.status === "rejected").length, 1);

  const summary = await run(`
    select
      count(*) filter(where metric='tips' and effect='credit')::text || ':' ||
      count(*) filter(where metric='commission' and effect='credit')::text || ':' ||
      sum(case when metric='tips' then case when effect='credit' then amount_cents else -amount_cents end else 0 end)::text || ':' ||
      sum(case when metric='commission' then case when effect='credit' then amount_cents else -amount_cents end else 0 end)::text
    from public.booking_financial_metric_evidence
    where salon_id='${ids.salon}';
  `);
  assert.equal(summary, "1:1:200:1000");
  console.log("tip commission concurrency passed");
} finally {
  await cleanup();
}
