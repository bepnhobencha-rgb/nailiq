#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const serviceCall = (body) => `
  select set_config('request.jwt.claim.role','service_role',true);
  ${body}
`;
const contactFingerprint = (name, phone, email) => createHash("sha256")
  .update([
    name.trim().toLowerCase().replace(/\s+/gu, " "),
    phone.replace(/[^0-9]/g, ""),
    email.trim().toLowerCase(),
  ].join("\n"), "utf8")
  .digest("hex");

const ids = {
  salon: "86370000-0000-4000-8000-000000000001",
  service: "86370000-0000-4000-8000-000000000002",
  staff: "86370000-0000-4000-8000-000000000003",
  bookingOne: "86370000-0000-4000-8000-000000000004",
  bookingTwo: "86370000-0000-4000-8000-000000000005",
};
const category = "square-writeback-concurrency-36000";
const teamMember = "square-team-member-8637";
const variation = "square-variation-8637";
const sharedProviderBooking = "square-booking-race-8637";
const contacts = {
  [ids.bookingOne]: {
    name: "Square Concurrency One",
    phone: "+16045558647",
    email: "square-concurrency-one@nailiq.invalid",
  },
  [ids.bookingTwo]: {
    name: "Square Concurrency Two",
    phone: "+16045558648",
    email: "square-concurrency-two@nailiq.invalid",
  },
};

const cleanup = () => run(`
  delete from public.square_booking_writeback_operations
    where salon_id='${ids.salon}';
  delete from public.bookings where salon_id='${ids.salon}';
  delete from public.square_integrations where salon_id='${ids.salon}';
  delete from public.staff where salon_id='${ids.salon}';
  delete from public.services where salon_id='${ids.salon}';
  delete from public.salons where id='${ids.salon}';
  delete from public.service_categories where slug='${category}';
`);
const claimSql = (bookingId) => {
  const contact = contacts[bookingId];
  const fingerprint = contactFingerprint(contact.name, contact.phone, contact.email);
  return serviceCall(`
    select public.claim_square_booking_writeback(
      '${ids.salon}','${bookingId}','${teamMember}','${variation}',17,
      '${fingerprint}','2024-12-18'
    )::text;
  `);
};

try {
  await cleanup();
  await run(`
    insert into public.service_categories(slug,name_en,name_vi)
      values('${category}','Square writeback concurrency','Square writeback concurrency');
    insert into public.salons(id,slug,name,phone,timezone,currency_code)
      values('${ids.salon}','${category}','Square writeback concurrency',
        '+16045558646','UTC','CAD');
    insert into public.services(
      id,salon_id,name,price_cents,duration_minutes,category,square_catalog_item_id
    ) values(
      '${ids.service}','${ids.salon}','101 - Signature Gel',5500,30,
      '${category}','square-item-8637'
    );
    insert into public.staff(id,salon_id,name,square_team_member_id)
      values('${ids.staff}','${ids.salon}','Square concurrency staff','${teamMember}');
    insert into public.square_integrations(
      salon_id,merchant_id,location_id,access_token,enabled,application_id,
      environment,sync_push_create
    ) values(
      '${ids.salon}','square-merchant-8637','square-location-8637',
      'local-concurrency-token-never-sent',true,'square-application-8637',
      'sandbox',true
    );
    insert into public.bookings(
      id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
      start_time_utc,end_time_utc,status,booking_channel,idempotency_key
    ) values
    (
      '${ids.bookingOne}','${ids.salon}','${ids.service}','${ids.staff}',
      '${contacts[ids.bookingOne].name}','${contacts[ids.bookingOne].phone}',
      '${contacts[ids.bookingOne].email}',date_trunc('hour',now())+interval '30 days',
      date_trunc('hour',now())+interval '30 days 30 minutes','confirmed','online',
      '${ids.bookingOne}'
    ),
    (
      '${ids.bookingTwo}','${ids.salon}','${ids.service}','${ids.staff}',
      '${contacts[ids.bookingTwo].name}','${contacts[ids.bookingTwo].phone}',
      '${contacts[ids.bookingTwo].email}',date_trunc('hour',now())+interval '30 days 2 hours',
      date_trunc('hour',now())+interval '30 days 2 hours 30 minutes','confirmed','online',
      '${ids.bookingTwo}'
    );
  `);

  const firstClaims = (await Promise.all(
    Array.from({ length: 8 }, () => run(claimSql(ids.bookingOne))),
  )).map(JSON.parse);
  assert.equal(firstClaims.filter((row) => row.code === "operation_claimed").length, 1);
  assert.equal(firstClaims.filter((row) => row.code === "operation_in_flight").length, 7);
  assert.equal(new Set(firstClaims.map((row) => row.operation_id)).size, 1);
  const first = firstClaims.find((row) => row.code === "operation_claimed");

  const firstDispatches = (await Promise.all(Array.from({ length: 8 }, () => run(serviceCall(`
    select public.begin_square_booking_writeback_dispatch(
      '${first.operation_id}','${first.attempt_token}','${first.material_fingerprint}'
    )::text;
  `))))).map(JSON.parse);
  assert.equal(firstDispatches.filter((row) => row.code === "dispatch_authorized").length, 1);
  assert.equal(firstDispatches.filter((row) => row.code === "reconciliation_required").length, 7);
  await run(serviceCall(`
    select public.record_square_booking_writeback_customer(
      '${first.operation_id}','${first.attempt_token}','square-customer-one-8637',
      repeat('a',64)
    );
  `));

  const second = JSON.parse(await run(claimSql(ids.bookingTwo)));
  assert.equal(second.code, "operation_claimed");
  const secondDispatch = JSON.parse(await run(serviceCall(`
    select public.begin_square_booking_writeback_dispatch(
      '${second.operation_id}','${second.attempt_token}','${second.material_fingerprint}'
    )::text;
  `)));
  assert.equal(secondDispatch.code, "dispatch_authorized");
  await run(serviceCall(`
    select public.record_square_booking_writeback_customer(
      '${second.operation_id}','${second.attempt_token}','square-customer-two-8637',
      repeat('b',64)
    );
  `));

  const receiptRace = (await Promise.all([
    run(serviceCall(`
      select public.mark_square_booking_writeback_unknown(
        '${first.operation_id}','${first.attempt_token}','provider_response_unknown',
        repeat('c',64),'${sharedProviderBooking}','square-customer-one-8637',9
      )::text;
    `)),
    run(serviceCall(`
      select public.mark_square_booking_writeback_unknown(
        '${second.operation_id}','${second.attempt_token}','provider_response_unknown',
        repeat('d',64),'${sharedProviderBooking}','square-customer-two-8637',9
      )::text;
    `)),
  ])).map(JSON.parse);
  assert.equal(receiptRace.every((row) => row.code === "operation_unknown"), true);
  assert.equal(await run(`
    select count(*) from public.square_booking_writeback_operations
    where salon_id='${ids.salon}' and provider_booking_id='${sharedProviderBooking}'
  `), "1");
  assert.equal(await run(`
    select count(*) from public.square_booking_writeback_operations
    where salon_id='${ids.salon}' and error_code='provider_receipt_conflict'
  `), "1");

  const receiptOwner = await run(`
    select booking_id::text from public.square_booking_writeback_operations
    where salon_id='${ids.salon}' and provider_booking_id='${sharedProviderBooking}'
  `);
  await run(`
    update public.square_booking_writeback_operations
    set next_reconcile_at=clock_timestamp()-interval '1 second'
    where salon_id='${ids.salon}' and booking_id='${receiptOwner}'
  `);
  const reconcileSql = serviceCall(`
    select public.claim_square_booking_writeback_reconciliation(
      '${ids.salon}','${receiptOwner}'
    )::text;
  `);
  const reconciliations = (await Promise.all(
    Array.from({ length: 8 }, () => run(reconcileSql)),
  )).map(JSON.parse);
  assert.equal(reconciliations.filter((row) => row.code === "reconciliation_claimed").length, 1);
  assert.equal(reconciliations.filter((row) => row.code === "operation_in_flight").length, 7);
  const winner = reconciliations.find((row) => row.code === "reconciliation_claimed");
  const providerCustomer = receiptOwner === ids.bookingOne
    ? "square-customer-one-8637"
    : "square-customer-two-8637";
  const completion = JSON.parse(await run(serviceCall(`
    select public.complete_square_booking_writeback_success(
      '${winner.operation_id}','${winner.attempt_token}','${sharedProviderBooking}',
      '${providerCustomer}',9,repeat('e',64)
    )::text;
  `)));
  assert.equal(completion.code, "operation_completed");
  assert.equal(await run(`
    select square_booking_id from public.bookings where id='${receiptOwner}'
  `), sharedProviderBooking);
  const replay = JSON.parse(await run(serviceCall(`
    select public.complete_square_booking_writeback_success(
      '${winner.operation_id}','${winner.attempt_token}','${sharedProviderBooking}',
      '${providerCustomer}',9,repeat('e',64)
    )::text;
  `)));
  assert.equal(replay.code, "completion_replay");

  console.log("square booking writeback concurrency passed");
} finally {
  await cleanup();
}
