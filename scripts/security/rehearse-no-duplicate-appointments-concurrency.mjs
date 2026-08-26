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
const ids = {
  salon: "50620000-0000-4000-8000-000000000001",
  actor: "50620000-0000-4000-8000-000000000002",
  service: "50620000-0000-4000-8000-000000000003",
  staff: "50620000-0000-4000-8000-000000000004",
  sameRequest: "50620000-0000-4000-8000-000000000005",
  raceA: "50620000-0000-4000-8000-000000000006",
  raceB: "50620000-0000-4000-8000-000000000007",
};
const category = "mqa0062-concurrency";

const sql = async (statement) => (await execFileAsync(
  psql,
  [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
  { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
)).stdout.trim();
const lastJson = (value) => JSON.parse(value.split("\n").filter(Boolean).at(-1));

const cleanup = async () => sql(`
  delete from public.client_profiles where phone in ('16045550621','16045550622','16045550623');
  delete from public.salons where id='${ids.salon}';
  delete from auth.users where id='${ids.actor}';
  delete from public.service_categories where slug='${category}';
`).catch(() => {});

const create = ({ request, phone, start, end, fingerprint, notifySms = false }) => `
  select set_config('request.jwt.claim.role','service_role',true);
  select public.create_public_booking_for_desk_with_staff_notification(
    '${ids.salon}','${ids.service}','${ids.staff}','MQA 0062','${phone}',
    '${start}','${end}','confirmed',null,'{}'::uuid[],null,null,null,null,false,
    '${request}','${fingerprint}','${ids.actor}',false,${notifySms},5
  )::text;`;

try {
  await cleanup();
  await sql(`
    insert into auth.users(id,email,created_at) values('${ids.actor}','mqa0062@nailiq.invalid',now());
    insert into public.service_categories(slug,name_en,name_vi)
      values('${category}','MQA 0062','MQA 0062');
    insert into public.salons(
      id,slug,name,phone,timezone,currency_code,sms_outbound_enabled,opening_hours
    ) values(
      '${ids.salon}','mqa0062-concurrency','MQA 0062','+16045550620','UTC','CAD',true,
      '{
        "sun":{"open":"00:00","close":"23:59","closed":false},
        "mon":{"open":"00:00","close":"23:59","closed":false},
        "tue":{"open":"00:00","close":"23:59","closed":false},
        "wed":{"open":"00:00","close":"23:59","closed":false},
        "thu":{"open":"00:00","close":"23:59","closed":false},
        "fri":{"open":"00:00","close":"23:59","closed":false},
        "sat":{"open":"00:00","close":"23:59","closed":false}
      }'::jsonb
    );
    insert into public.salon_members(salon_id,user_id,role)
      values('${ids.salon}','${ids.actor}','owner');
    insert into public.services(
      id,salon_id,name,price_cents,duration_minutes,buffer_minutes,category,is_addon,addon_timing
    ) values('${ids.service}','${ids.salon}','MQA 0062',5000,30,0,'${category}',false,'sequential');
    insert into public.staff(id,salon_id,name,status)
      values('${ids.staff}','${ids.salon}','MQA 0062 Staff','active');
    insert into public.staff_services(staff_id,service_id) values('${ids.staff}','${ids.service}');
  `);

  const base = await sql("select (date_trunc('day',clock_timestamp())+interval '15 days 10 hours')::text");
  const end = await sql(`select ('${base}'::timestamptz+interval '30 minutes')::text`);
  const quote = lastJson(await sql(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.quote_public_booking(
      '${ids.salon}','${ids.service}','${ids.staff}','${base}','${end}',
      '{}'::uuid[],null,null,'16045550621',null,false
    )::text;`));
  assert.equal(quote.code, "quoted", JSON.stringify(quote));

  const same = (await Promise.all([
    sql(create({ request: ids.sameRequest, phone: "16045550621", start: base, end,
      fingerprint: quote.pricing_fingerprint, notifySms: true })),
    sql(create({ request: ids.sameRequest, phone: "16045550621", start: base, end,
      fingerprint: quote.pricing_fingerprint, notifySms: true })),
  ])).map(lastJson);
  assert.deepEqual(same.map((v) => v.idempotent).sort(), [false, true]);
  assert.equal(new Set(same.map((v) => v.booking_id)).size, 1);
  assert.equal(await sql(`select count(*) from public.bookings
    where salon_id='${ids.salon}' and idempotency_key='${ids.sameRequest}'`), "1");
  assert.equal(await sql(`select count(*) from public.staff_action_notification_outbox
    where salon_id='${ids.salon}' and request_id='${ids.sameRequest}'`), "1");
  assert.equal(await sql(`select count(*) from public.staff_action_notification_deliveries d
    join public.staff_action_notification_outbox o on o.id=d.outbox_id
    where o.salon_id='${ids.salon}' and o.request_id='${ids.sameRequest}'`), "1");

  const raceStart = await sql(`select ('${base}'::timestamptz+interval '2 hours')::text`);
  const raceEnd = await sql(`select ('${raceStart}'::timestamptz+interval '30 minutes')::text`);
  const [quoteA, quoteB] = (await Promise.all([
    sql(`select set_config('request.jwt.claim.role','service_role',true); select public.quote_public_booking(
      '${ids.salon}','${ids.service}','${ids.staff}','${raceStart}','${raceEnd}',
      '{}'::uuid[],null,null,'16045550622',null,false)::text;`),
    sql(`select set_config('request.jwt.claim.role','service_role',true); select public.quote_public_booking(
      '${ids.salon}','${ids.service}','${ids.staff}','${raceStart}','${raceEnd}',
      '{}'::uuid[],null,null,'16045550623',null,false)::text;`),
  ])).map(lastJson);
  assert.equal(quoteA.code, "quoted");
  assert.equal(quoteB.code, "quoted");
  const raced = (await Promise.all([
    sql(create({ request: ids.raceA, phone: "16045550622", start: raceStart, end: raceEnd,
      fingerprint: quoteA.pricing_fingerprint })),
    sql(create({ request: ids.raceB, phone: "16045550623", start: raceStart, end: raceEnd,
      fingerprint: quoteB.pricing_fingerprint })),
  ])).map(lastJson);
  assert.deepEqual(raced.map((v) => v.code).sort(), ["booked", "slot_conflict"]);
  assert.equal(await sql(`select count(*) from public.bookings where salon_id='${ids.salon}'
    and idempotency_key in ('${ids.raceA}','${ids.raceB}')`), "1");
  const loserPhone = raced[0].code === "slot_conflict" ? "16045550622" : "16045550623";
  assert.equal(await sql(`select count(*) from public.client_profiles where phone='${loserPhone}'`), "0");

  console.log("PASS desk exact replay and overlapping staff appointment concurrency");
} finally {
  await cleanup();
}
