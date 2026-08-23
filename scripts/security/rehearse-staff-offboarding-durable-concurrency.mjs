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
const parsed = new URL(dbUrl);
if (!["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(parsed.hostname)) {
  throw new Error(`Refusing non-local database host: ${parsed.hostname}`);
}

const ids = {
  salon: "d6600000-0000-4000-8000-000000000001",
  service: "d6600000-0000-4000-8000-000000000002",
  departing: "d6600000-0000-4000-8000-000000000003",
  replacement: "d6600000-0000-4000-8000-000000000004",
  actor: "d6600000-0000-4000-8000-000000000005",
  request: "d6600000-0000-4000-8000-000000000011",
  otherRequest: "d6600000-0000-4000-8000-000000000012",
  raceRequest: "d6600000-0000-4000-8000-000000000013",
  booking1: "d6600000-0000-4000-8000-000000000020",
  booking2: "d6600000-0000-4000-8000-000000000021",
  booking3: "d6600000-0000-4000-8000-000000000022",
  booking4: "d6600000-0000-4000-8000-000000000023",
  sequenceBooking: "d6600000-0000-4000-8000-000000000024",
  sequenceSegment1: "d6600000-0000-4000-8000-000000000025",
  sequenceSegment2: "d6600000-0000-4000-8000-000000000026",
  sequenceLine1: "d6600000-0000-4000-8000-000000000027",
  sequenceLine2: "d6600000-0000-4000-8000-000000000028",
  pendingWriterBooking: "d6600000-0000-4000-8000-000000000029",
  pendingLateBooking: "d6600000-0000-4000-8000-000000000030",
};

async function sql(statement) {
  const { stdout } = await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim();
}

function json(output) {
  return JSON.parse(output.split("\n").filter((line) => line.startsWith("{")).at(-1));
}

async function cleanup() {
  await sql(`delete from public.salons where id='${ids.salon}';
    delete from auth.users where id='${ids.actor}';
    delete from public.service_categories where slug='staff-offboarding-concurrency-qa';`);
}

const assignments = JSON.stringify([
  { booking_id: ids.booking1, staff_id: ids.replacement },
  { booking_id: ids.booking2, staff_id: ids.replacement },
]).replaceAll("'", "''");

try {
  await cleanup();
  await sql(`
    insert into public.service_categories(slug,name_en,name_vi)
    values('staff-offboarding-concurrency-qa','Staff offboarding concurrency','Staff offboarding concurrency');
    insert into public.salons(id,slug,name,phone,timezone,sms_outbound_enabled,email_outbound_enabled)
    values('${ids.salon}','e2e-staff-offboarding-concurrency',
      'E2E Staff offboarding concurrency','+16045550660','UTC',false,true);
    insert into public.services(id,salon_id,name,price_cents,duration_minutes,category)
    values('${ids.service}','${ids.salon}','Concurrency service',3000,30,
      'staff-offboarding-concurrency-qa');
    insert into public.staff(id,salon_id,name,status) values
      ('${ids.departing}','${ids.salon}','Concurrency departing','active'),
      ('${ids.replacement}','${ids.salon}','Concurrency replacement','active');
    insert into auth.users(id,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at)
    values('${ids.actor}','staff-offboarding-concurrency@nailiq.invalid','',now(),
      '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now());
    insert into public.salon_members(salon_id,user_id,role)
    values('${ids.salon}','${ids.actor}','owner');
    insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
      client_email,start_time_utc,end_time_utc,status,price_cents) values
      ('${ids.booking1}','${ids.salon}','${ids.service}','${ids.departing}',
       'Concurrency guest 1','+16045550661','concurrency1@example.test',
       now()+interval '2 days',now()+interval '2 days 30 minutes','confirmed',3000),
      ('${ids.booking2}','${ids.salon}','${ids.service}','${ids.departing}',
       'Concurrency guest 2','+16045550662','concurrency2@example.test',
       now()+interval '2 days 1 hour',now()+interval '2 days 1 hour 30 minutes',
       'pending',3000);
    insert into public.bookings(
      id,salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,source,price_cents,
      original_price_cents,subtotal_cents,tax_amount_cents,schedule_model,
      sequence_version,public_booking_request_fingerprint,
      public_booking_pricing_fingerprint,public_booking_pricing_snapshot
    ) values(
      '${ids.sequenceBooking}','${ids.salon}','${ids.service}','${ids.replacement}',
      'Concurrency sequence guest','+16045550665',
      date_trunc('day',now()+interval '5 days')+interval '10 hours',
      date_trunc('day',now()+interval '5 days')+interval '11 hours',
      'confirmed','appointment',6000,6000,6000,0,'segments_v1',1,
      repeat('e',64),repeat('f',64),
      jsonb_build_object('schedule_model','segments_v1')
    );
    insert into public.booking_service_segments(
      id,booking_id,salon_id,position,line_id,service_id,staff_id,
      customer_start_utc,customer_end_utc,occupied_start_utc,occupied_end_utc,
      prep_minutes,service_duration_minutes,sequential_addon_minutes,
      trailing_buffer_minutes,service_name,staff_name,
      original_service_price_cents,service_pre_voucher_cents,
      addon_pre_voucher_cents,promo_discount_cents,email_discount_cents,
      voucher_discount_cents,service_price_cents,addon_price_cents,
      subtotal_cents,tax_cents,total_cents,reservation_status
    ) values
      ('${ids.sequenceSegment1}','${ids.sequenceBooking}','${ids.salon}',0,
       '${ids.sequenceLine1}','${ids.service}','${ids.replacement}',
       date_trunc('day',now()+interval '5 days')+interval '10 hours',
       date_trunc('day',now()+interval '5 days')+interval '10 hours 30 minutes',
       date_trunc('day',now()+interval '5 days')+interval '10 hours',
       date_trunc('day',now()+interval '5 days')+interval '10 hours 30 minutes',
       0,30,0,0,'Concurrency service','Concurrency replacement',
       3000,3000,0,0,0,0,3000,0,3000,0,3000,'confirmed'),
      ('${ids.sequenceSegment2}','${ids.sequenceBooking}','${ids.salon}',1,
       '${ids.sequenceLine2}','${ids.service}','${ids.replacement}',
       date_trunc('day',now()+interval '5 days')+interval '10 hours 30 minutes',
       date_trunc('day',now()+interval '5 days')+interval '11 hours',
       date_trunc('day',now()+interval '5 days')+interval '10 hours 30 minutes',
       date_trunc('day',now()+interval '5 days')+interval '11 hours',
       0,30,0,0,'Concurrency service','Concurrency replacement',
       3000,3000,0,0,0,0,3000,0,3000,0,3000,'confirmed');
    set constraints check_booking_service_sequence_shape immediate;
    set constraints check_booking_service_sequence_shape deferred;
  `);

  const call = `begin; set local role service_role;
    select public.offboard_staff_with_durable_notifications(
      '${ids.salon}','${ids.departing}','${ids.request}','${ids.actor}','owner',
      '${assignments}'::jsonb,true,false,false,20)::text; commit;`;
  const results = (await Promise.all([sql(call), sql(call)])).map(json);
  assert.deepEqual(results.map((result) => result.code), [
    "staff_offboarded",
    "staff_offboarded",
  ]);
  assert.deepEqual(results.map((result) => result.idempotent).sort(), [false, true]);
  assert.deepEqual(results.map((result) => result.reassigned_count), [2, 2]);
  assert.deepEqual(results.map((result) => result.notification_events_queued), [2, 2]);
  assert.deepEqual(results.map((result) => result.notification_deliveries_queued), [2, 2]);
  assert.deepEqual(results.map((result) => result.audit_events_recorded), [2, 2]);
  assert.deepEqual(results[0].assignments, results[1].assignments);

  assert.equal(await sql(`select count(*) from public.staff_offboarding_receipts
    where salon_id='${ids.salon}' and request_id='${ids.request}'`), "1");
  assert.equal(await sql(`select count(*) from public.staff_action_notification_outbox
    where salon_id='${ids.salon}' and event_type='staff_change'`), "2");
  assert.equal(await sql(`select count(distinct request_id) from public.staff_action_notification_outbox
    where salon_id='${ids.salon}' and event_type='staff_change'`), "2");
  assert.equal(await sql(`select count(*) from public.staff_action_notification_deliveries d
    join public.staff_action_notification_outbox o on o.id=d.outbox_id
    where o.salon_id='${ids.salon}' and o.event_type='staff_change'
      and d.channel='email' and d.status='awaiting_material'`), "2");
  assert.equal(await sql(`select count(*) from public.booking_events
    where salon_id='${ids.salon}' and staff_offboarding_request_id='${ids.request}'`), "2");
  assert.equal(await sql(`select count(*) from public.bookings
    where salon_id='${ids.salon}' and staff_id='${ids.replacement}'
      and id in ('${ids.booking1}','${ids.booking2}')`), "2");
  assert.equal(await sql(`select status from public.staff where id='${ids.departing}'`), "inactive");

  const different = json(await sql(`begin; set local role service_role;
    select public.offboard_staff_with_durable_notifications(
      '${ids.salon}','${ids.departing}','${ids.otherRequest}','${ids.actor}','owner',
      '${assignments}'::jsonb,true,false,false,20)::text; commit;`));
  assert.equal(different.code, "already_inactive");
  assert.equal(await sql(`select count(*) from public.staff_action_notification_outbox
    where salon_id='${ids.salon}' and event_type='staff_change'`), "2");

  // A writer that starts first holds the target's update lock through the
  // active-staff trigger. Offboarding must wait, observe the committed booking,
  // and include it atomically instead of deactivating staff behind that writer.
  await sql(`update public.staff set status='active' where id='${ids.departing}'`);
  const writer = sql(`begin; set local role service_role;
    insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,price_cents) values(
      '${ids.booking3}','${ids.salon}','${ids.service}','${ids.departing}',
      'Writer first guest','+16045550663',now()+interval '3 days',
      now()+interval '3 days 30 minutes','confirmed',3000);
    select pg_sleep(0.5); commit;`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const raceAssignments = JSON.stringify([
    { booking_id: ids.booking3, staff_id: ids.replacement },
  ]).replaceAll("'", "''");
  const racedOffboarding = sql(`begin; set local role service_role;
    select public.offboard_staff_with_durable_notifications(
      '${ids.salon}','${ids.departing}','${ids.raceRequest}','${ids.actor}','owner',
      '${raceAssignments}'::jsonb,false,false,false,20)::text; commit;`);
  const [raceResult] = (await Promise.all([racedOffboarding, writer])).map((value) =>
    value.startsWith("{") ? json(value) : null,
  );
  assert.equal(raceResult.code, "staff_offboarded");
  assert.equal(raceResult.reassigned_count, 1);
  assert.equal(raceResult.audit_events_recorded, 1);
  assert.equal(await sql(`select staff_id from public.bookings where id='${ids.booking3}'`),
    ids.replacement);
  assert.equal(await sql(`select status from public.staff where id='${ids.departing}'`),
    "inactive");

  // A writer that starts after deactivation waits on/reads the same staff row
  // and fails closed before any live booking can reference inactive staff.
  await assert.rejects(sql(`begin; set local role service_role;
    insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,price_cents) values(
      '${ids.booking4}','${ids.salon}','${ids.service}','${ids.departing}',
      'Writer late guest','+16045550664',now()+interval '4 days',
      now()+interval '4 days 30 minutes','confirmed',3000); commit;`));

  // Parent writer first: its booking row and staff FOR UPDATE lock commit
  // before a concurrent active->pending transition can run. The staff-side
  // scan then observes the parent assignment and rejects the transition.
  await sql(`update public.staff set status='active' where id='${ids.departing}'`);
  const parentWriterFirst = sql(`begin; set local role service_role;
    insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,price_cents) values(
      '${ids.pendingWriterBooking}','${ids.salon}','${ids.service}','${ids.departing}',
      'Pending writer first','+16045550666',now()+interval '7 days',
      now()+interval '7 days 30 minutes','confirmed',3000);
    select pg_sleep(0.5); commit;`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const pendingAgainstParent = sql(`begin; set local role service_role;
    update public.staff set status='pending' where id='${ids.departing}';
    commit;`);
  const [parentFirstResult, pendingParentResult] = await Promise.allSettled([
    parentWriterFirst,
    pendingAgainstParent,
  ]);
  assert.equal(parentFirstResult.status, "fulfilled");
  assert.equal(pendingParentResult.status, "rejected");
  assert.equal(await sql(`select status from public.staff where id='${ids.departing}'`),
    "active");
  await sql(`update public.bookings set staff_id='${ids.replacement}'
    where id='${ids.pendingWriterBooking}'`);

  // Status first: pending commits while holding the staff row. A later parent
  // writer waits on that row and then rejects the now non-active assignment.
  const pendingFirst = sql(`begin; set local role service_role;
    update public.staff set status='pending' where id='${ids.departing}';
    select pg_sleep(0.5); commit;`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const parentWriterLate = sql(`begin; set local role service_role;
    insert into public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,price_cents) values(
      '${ids.pendingLateBooking}','${ids.salon}','${ids.service}','${ids.departing}',
      'Pending writer late','+16045550667',now()+interval '8 days',
      now()+interval '8 days 30 minutes','confirmed',3000); commit;`);
  const [pendingFirstResult, parentLateResult] = await Promise.allSettled([
    pendingFirst,
    parentWriterLate,
  ]);
  assert.equal(pendingFirstResult.status, "fulfilled");
  assert.equal(parentLateResult.status, "rejected");
  assert.equal(await sql(`select status from public.staff where id='${ids.departing}'`),
    "pending");
  assert.equal(await sql(`select count(*) from public.bookings
    where id='${ids.pendingLateBooking}'`), "0");

  // Segment writer first: it owns the segment row and then the departing staff
  // row FOR UPDATE. A direct staff status change waits, observes the committed
  // segment assignment and rejects without a deadlock.
  await sql(`update public.staff set status='active' where id='${ids.departing}'`);
  const segmentWriterFirst = sql(`begin; set local role service_role;
    select set_config('nailiq.sequence_reschedule_booking_id',
      '${ids.sequenceBooking}',true);
    update public.booking_service_segments
    set staff_id='${ids.departing}', staff_name='Concurrency departing'
    where id='${ids.sequenceSegment2}';
    select pg_sleep(0.5); commit;`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const directPending = sql(`begin; set local role service_role;
    update public.staff set status='pending' where id='${ids.departing}';
    commit;`);
  const [segmentFirstResult, pendingSegmentResult] = await Promise.allSettled([
    segmentWriterFirst,
    directPending,
  ]);
  assert.equal(segmentFirstResult.status, "fulfilled");
  assert.equal(pendingSegmentResult.status, "rejected");
  assert.equal(await sql(`select status from public.staff where id='${ids.departing}'`),
    "active");
  assert.equal(await sql(`select staff_id from public.booking_service_segments
    where id='${ids.sequenceSegment2}'`), ids.departing);

  // A direct hard delete also sees segment-only live use before referential
  // cleanup and fails closed through the staff-side invariant.
  await assert.rejects(sql(`begin; set local role service_role;
    delete from public.staff where id='${ids.departing}'; commit;`));
  assert.equal(await sql(`select count(*) from public.staff where id='${ids.departing}'`),
    "1");

  await sql(`begin; set local role service_role;
    select set_config('nailiq.sequence_reschedule_booking_id',
      '${ids.sequenceBooking}',true);
    update public.booking_service_segments
    set staff_id='${ids.replacement}', staff_name='Concurrency replacement'
    where id='${ids.sequenceSegment2}'; commit;`);

  // Staff status first: the invariant sees no live target assignment and the
  // transaction holds the staff row. A later segment writer waits, then its
  // active-staff trigger rejects after the pending status commits.
  const statusFirst = sql(`begin; set local role service_role;
    update public.staff set status='pending' where id='${ids.departing}';
    select pg_sleep(0.5); commit;`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const segmentWriterLate = sql(`begin; set local role service_role;
    select set_config('nailiq.sequence_reschedule_booking_id',
      '${ids.sequenceBooking}',true);
    update public.booking_service_segments
    set staff_id='${ids.departing}', staff_name='Concurrency departing'
    where id='${ids.sequenceSegment2}'; commit;`);
  const [statusFirstResult, segmentLateResult] = await Promise.allSettled([
    statusFirst,
    segmentWriterLate,
  ]);
  assert.equal(statusFirstResult.status, "fulfilled");
  assert.equal(segmentLateResult.status, "rejected");
  assert.equal(await sql(`select status from public.staff where id='${ids.departing}'`),
    "pending");
  assert.equal(await sql(`select staff_id from public.booking_service_segments
    where id='${ids.sequenceSegment2}'`), ids.replacement);

  process.stdout.write(
    "PASS two-session replay plus booking/segment assignment vs staff status/delete coordination\n",
  );
} finally {
  await cleanup();
}
