#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dbUrl = process.env.DB_URL;
const psql = process.env.PSQL_BIN ?? "psql";
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !dbUrl) {
  throw new Error("Refusing without NAILIQ_DISPOSABLE_DB=1 and DB_URL");
}
const host = new URL(dbUrl).hostname;
if (!["", "localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-local database host: ${host}`);
}

const run = async (statement) => (
  await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  )
).stdout.trim();

const id = {
  salon: "49000000-0000-4000-8000-000000000101",
  service: "49000000-0000-4000-8000-000000000102",
  staffA: "49000000-0000-4000-8000-000000000103",
  staffB: "49000000-0000-4000-8000-000000000104",
  staffVacation: "49000000-0000-4000-8000-000000000105",
  room: "49000000-0000-4000-8000-000000000106",
  bookingA: "49000000-0000-4000-8000-000000000107",
  bookingB: "49000000-0000-4000-8000-000000000108",
  vacationA: "49000000-0000-4000-8000-000000000109",
  vacationB: "49000000-0000-4000-8000-000000000110",
};
const category = "capacity-concurrency-rehearsal";
const base = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
base.setUTCHours(10, 0, 0, 0);
const start = base.toISOString();
const vacationDate = start.slice(0, 10);

const cleanup = async () => {
  await run(`
    select set_config('request.jwt.claim.role','service_role',false);
    delete from public.bookings where salon_id='${id.salon}';
    -- Delete schedule rows while the salon still exists so their availability
    -- revision triggers can complete before the tenant cascade.
    delete from public.staff_unavailability where salon_id='${id.salon}';
    delete from public.salon_resources where salon_id='${id.salon}';
    -- Delete the fixture through the supported tenant cascade. Directly
    -- deleting the final staff_services row is intentionally fail closed and
    -- would roll back this entire cleanup transaction.
    delete from public.salons where id='${id.salon}';
    delete from public.service_categories where slug='${category}';
  `);
};

const insertBooking = ({ booking, staff, phone, resource, offsetMinutes = 0 }) => {
  const bookingStart = new Date(base.getTime() + offsetMinutes * 60_000).toISOString();
  const bookingEnd = new Date(base.getTime() + (offsetMinutes + 30) * 60_000).toISOString();
  return `begin;
    insert into public.bookings(
      id,salon_id,service_id,staff_id,resource_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,source,schedule_model
    ) values(
      '${booking}','${id.salon}','${id.service}','${staff}',
      ${resource ? `'${resource}'` : "null"},'Concurrency ${phone}','${phone}',
      '${bookingStart}','${bookingEnd}','confirmed','appointment','single'
    );
    select pg_sleep(0.05);
    commit;`;
};

try {
  await cleanup();
  await run(`
    insert into public.service_categories(slug,name_en,name_vi)
    values('${category}','Capacity concurrency','Capacity concurrency');
    insert into public.salons(
      id,slug,name,phone,timezone,currency_code,resources_enabled
    ) values(
      '${id.salon}','capacity-concurrency','Capacity concurrency',
      '+16045550600','UTC','CAD',true
    );
    insert into public.services(
      id,salon_id,name,price_cents,duration_minutes,buffer_minutes,
      category,is_addon,addon_timing
    ) values(
      '${id.service}','${id.salon}','Capacity service',5000,30,0,
      '${category}',false,'sequential'
    );
    insert into public.staff(id,salon_id,name,status) values
      ('${id.staffA}','${id.salon}','Capacity A','active'),
      ('${id.staffB}','${id.salon}','Capacity B','active'),
      ('${id.staffVacation}','${id.salon}','Capacity Vacation','active');
    insert into public.staff_services(staff_id,service_id) values
      ('${id.staffA}','${id.service}'),('${id.staffB}','${id.service}'),
      ('${id.staffVacation}','${id.service}');
    insert into public.salon_resources(id,salon_id,name,kind,status)
    values('${id.room}','${id.salon}','Shared Concurrency Room','room','active');
  `);

  // Different staff racing for one shared room: exactly one commits.
  const roomRace = await Promise.allSettled([
    run(insertBooking({
      booking: id.bookingA, staff: id.staffA, phone: "16045550601",
      resource: id.room,
    })),
    run(insertBooking({
      booking: id.bookingB, staff: id.staffB, phone: "16045550602",
      resource: id.room,
    })),
  ]);
  assert.equal(roomRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(roomRace.filter((result) => result.status === "rejected").length, 1);
  assert.equal(await run(`select count(*) from public.bookings
    where id in ('${id.bookingA}','${id.bookingB}')`), "1");

  await run(`
    delete from public.bookings where id in ('${id.bookingA}','${id.bookingB}');
    insert into public.staff_unavailability(staff_id,salon_id,date,reason)
    values('${id.staffVacation}','${id.salon}','${vacationDate}','Vacation race');
  `);

  // Concurrent direct writers cannot bypass an already configured vacation.
  const vacationRace = await Promise.allSettled([
    run(insertBooking({
      booking: id.vacationA, staff: id.staffVacation,
      phone: "16045550603", resource: id.room,
    })),
    run(insertBooking({
      booking: id.vacationB, staff: id.staffVacation,
      phone: "16045550604", resource: id.room, offsetMinutes: 60,
    })),
  ]);
  assert.equal(vacationRace.filter((result) => result.status === "rejected").length, 2);
  assert.equal(await run(`select count(*) from public.bookings
    where id in ('${id.vacationA}','${id.vacationB}')`), "0");

  // Resource-mode cannot be bypassed with a null resource.
  await assert.rejects(run(insertBooking({
    booking: id.vacationA, staff: id.staffA,
    phone: "16045550605", resource: null, offsetMinutes: 120,
  })));

  console.log("booking vacation/resource capacity concurrency passed");
} finally {
  await cleanup();
}
