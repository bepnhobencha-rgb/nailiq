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

const run = async (sql) => (
  await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  )
).stdout.trim();

const ids = {
  owner: "51870000-0000-4000-8000-000000000001",
  salonA: "51870000-0000-4000-8000-000000000011",
  salonB: "51870000-0000-4000-8000-000000000012",
  serviceA: "51870000-0000-4000-8000-000000000021",
  serviceB: "51870000-0000-4000-8000-000000000022",
  staffA: "51870000-0000-4000-8000-000000000031",
  staffB: "51870000-0000-4000-8000-000000000032",
  organization: "51870000-0000-4000-8000-000000000041",
  organizationStaff: "51870000-0000-4000-8000-000000000042",
  client: "51870000-0000-4000-8000-000000000051",
  program: "51870000-0000-4000-8000-000000000061",
  bookingA: "51870000-0000-4000-8000-000000000071",
  bookingB: "51870000-0000-4000-8000-000000000072",
  raceBookingA: "51870000-0000-4000-8000-000000000081",
  raceBookingB: "51870000-0000-4000-8000-000000000082",
  sameKey: "51870000-0000-4000-8000-000000000091",
  distinctKeyA: "51870000-0000-4000-8000-000000000092",
  distinctKeyB: "51870000-0000-4000-8000-000000000093",
};

const cleanup = async () => run(`
  delete from public.salon_organizations where id='${ids.organization}';
  delete from public.salons where id in ('${ids.salonA}','${ids.salonB}');
  delete from public.client_profiles where id='${ids.client}';
  delete from auth.users where id='${ids.owner}';
  delete from public.service_categories where slug='mqa-multilocation-concurrency';
`);

const loyaltySql = (bookingId, points, key) => `
  select set_config('request.jwt.claim.role','service_role',true);
  select applied::text || ':' || points_after::text
  from public.apply_organization_loyalty_event(
    '${ids.organization}',
    '${bookingId === ids.bookingA ? ids.salonA : ids.salonB}',
    '${ids.client}',
    '${bookingId}',
    'earn',
    ${points},
    '${key}',
    null
  );
`;

try {
  await cleanup();
  await run(`
    insert into auth.users(id,email,created_at)
      values('${ids.owner}','multilocation-concurrency@nailiq.invalid',now());
    insert into public.service_categories(slug,name_en,name_vi)
      values('mqa-multilocation-concurrency','MQA Multilocation Concurrency','MQA Multilocation Concurrency');
    insert into public.salons(id,slug,name,phone,timezone) values
      ('${ids.salonA}','mqa-multilocation-concurrency-a','MQA Concurrency A','+16045550911','America/Vancouver'),
      ('${ids.salonB}','mqa-multilocation-concurrency-b','MQA Concurrency B','+14165550912','America/Toronto');
    insert into public.salon_members(salon_id,user_id,role) values
      ('${ids.salonA}','${ids.owner}','owner'),
      ('${ids.salonB}','${ids.owner}','owner');
    insert into public.services(id,salon_id,name,duration_minutes,price_cents,category) values
      ('${ids.serviceA}','${ids.salonA}','Concurrency A',60,5000,'mqa-multilocation-concurrency'),
      ('${ids.serviceB}','${ids.salonB}','Concurrency B',60,6000,'mqa-multilocation-concurrency');
    insert into public.staff(id,salon_id,name,status) values
      ('${ids.staffA}','${ids.salonA}','Concurrency Tech A','active'),
      ('${ids.staffB}','${ids.salonB}','Concurrency Tech B','active');
    insert into public.salon_organizations(id,name,created_by)
      values('${ids.organization}','MQA Concurrency Chain','${ids.owner}');
    insert into public.salon_organization_members(organization_id,user_id,role)
      values('${ids.organization}','${ids.owner}','owner');
    insert into public.salon_organization_locations(organization_id,salon_id,is_primary) values
      ('${ids.organization}','${ids.salonA}',true),
      ('${ids.organization}','${ids.salonB}',false);
    insert into public.organization_staff(id,organization_id,display_name)
      values('${ids.organizationStaff}','${ids.organization}','Concurrency Tech');
    insert into public.organization_staff_locations(
      organization_id,organization_staff_id,salon_id,staff_id
    ) values
      ('${ids.organization}','${ids.organizationStaff}','${ids.salonA}','${ids.staffA}'),
      ('${ids.organization}','${ids.organizationStaff}','${ids.salonB}','${ids.staffB}');
    insert into public.client_profiles(id,phone,name)
      values('${ids.client}','+16045550951','Concurrency Client');
    insert into public.salon_clients(salon_id,client_profile_id,source) values
      ('${ids.salonA}','${ids.client}','booking'),
      ('${ids.salonB}','${ids.client}','booking');
    insert into public.organization_client_consents(
      organization_id,client_profile_id,consent_at,consent_source,granted_by
    ) values('${ids.organization}','${ids.client}',now(),'customer_opt_in','${ids.owner}');
    insert into public.organization_loyalty_programs(
      id,organization_id,name,points_required
    ) values('${ids.program}','${ids.organization}','Concurrency Rewards',10);
    insert into public.bookings(
      id,salon_id,service_id,client_profile_id,client_name,start_time_utc,
      end_time_utc,status,price_cents
    ) values
      ('${ids.bookingA}','${ids.salonA}','${ids.serviceA}','${ids.client}',
       'Concurrency Client','2026-09-10 17:00Z','2026-09-10 18:00Z','completed',5000),
      ('${ids.bookingB}','${ids.salonB}','${ids.serviceB}','${ids.client}',
       'Concurrency Client','2026-09-11 17:00Z','2026-09-11 18:00Z','completed',6000);
  `);

  const sameKeyRace = (await Promise.all([
    run(loyaltySql(ids.bookingA, 5, ids.sameKey)),
    run(loyaltySql(ids.bookingA, 5, ids.sameKey)),
  ])).map((result) => result.split("\n").at(-1));
  assert.deepEqual(sameKeyRace.sort(), ["false:5", "true:5"]);
  assert.equal(await run(`select count(*) from public.organization_loyalty_events
    where organization_id='${ids.organization}' and idempotency_key='${ids.sameKey}'`), "1");

  const distinctKeyRace = (await Promise.all([
    run(loyaltySql(ids.bookingA, 3, ids.distinctKeyA)),
    run(loyaltySql(ids.bookingB, 4, ids.distinctKeyB)),
  ])).map((result) => result.split("\n").at(-1));
  assert.equal(distinctKeyRace.every((result) => result.startsWith("true:")), true);
  assert.equal(distinctKeyRace.includes("true:12"), true);
  assert.equal(
    distinctKeyRace.includes("true:8") || distinctKeyRace.includes("true:9"),
    true,
  );
  assert.equal(await run(`select points_balance from public.organization_loyalty_accounts
    where organization_id='${ids.organization}' and client_profile_id='${ids.client}'`), "12");

  const bookingSql = (id, salon, service, staff) => `
    insert into public.bookings(
      id,salon_id,service_id,staff_id,client_name,start_time_utc,end_time_utc,status
    ) values(
      '${id}','${salon}','${service}','${staff}','Cross-location race',
      '2026-10-20 17:00Z','2026-10-20 18:00Z','confirmed'
    );
  `;
  const staffRace = await Promise.allSettled([
    run(bookingSql(ids.raceBookingA, ids.salonA, ids.serviceA, ids.staffA)),
    run(bookingSql(ids.raceBookingB, ids.salonB, ids.serviceB, ids.staffB)),
  ]);
  assert.equal(staffRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(staffRace.filter((result) => result.status === "rejected").length, 1);
  assert.equal(await run(`select count(*) from public.bookings
    where id in ('${ids.raceBookingA}','${ids.raceBookingB}')`), "1");

  console.log("salon organization concurrency passed");
} finally {
  await cleanup();
}
