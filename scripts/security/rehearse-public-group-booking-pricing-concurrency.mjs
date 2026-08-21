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
const parsedUrl = new URL(dbUrl);
if (!new Set(["", "localhost", "127.0.0.1", "[::1]", "::1"]).has(parsedUrl.hostname)) {
  throw new Error(`Refusing non-local database host: ${parsedUrl.hostname}`);
}

const ids = {
  salon: "b2000000-0000-4000-8000-000000000001",
  service: "b2000000-0000-4000-8000-000000000002",
  addon: "b2000000-0000-4000-8000-000000000003",
  staffA: "b2000000-0000-4000-8000-000000000004",
  staffB: "b2000000-0000-4000-8000-000000000005",
  voucher: "b2000000-0000-4000-8000-000000000006",
  replayIdem: "b2000000-0000-4000-8000-000000000007",
  voucherIdemA: "b2000000-0000-4000-8000-000000000008",
  voucherIdemB: "b2000000-0000-4000-8000-000000000009",
  slotIdemA: "b2000000-0000-4000-8000-000000000010",
  slotIdemB: "b2000000-0000-4000-8000-000000000011",
};

const runSql = async (statement) => {
  const { stdout } = await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout.trim();
};
const lastJson = (output) => JSON.parse(output.split("\n").filter(Boolean).at(-1));
const sqlJson = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const isoAt = (base, hours, minutes = 0) =>
  new Date(Date.parse(base) + (hours * 60 + minutes) * 60_000).toISOString();

const payloadAt = (base, offsetHours, label) => [
  {
    service_id: ids.service,
    staff_id: ids.staffA,
    start_time_utc: isoAt(base, offsetHours),
    end_time_utc: isoAt(base, offsetHours, 40),
    addon_service_ids: [ids.addon],
    client_name: `${label} organizer`,
    wave_number: 1,
  },
  {
    service_id: ids.service,
    staff_id: ids.staffB,
    start_time_utc: isoAt(base, offsetHours),
    end_time_utc: isoAt(base, offsetHours, 40),
    addon_service_ids: [],
    client_name: `${label} member`,
    wave_number: 1,
  },
];

const quote = async (payload, voucher, phone) => lastJson(await runSql(`
  select set_config('request.jwt.claim.role', 'service_role', true);
  select public.quote_group_booking(
    '${ids.salon}', ${sqlJson(payload)}, ${voucher ? `'${voucher}'` : "null"},
    '${phone}', null, false
  )::text;
`));
const createSql = (payload, voucher, phone, idem, fingerprint) => `
  select set_config('request.jwt.claim.role', 'service_role', true);
  select public.create_group_bookings(
    '${ids.salon}', ${sqlJson(payload)}, ${voucher ? `'${voucher}'` : "null"},
    '${phone}', null, false, '${idem}', '${fingerprint}'
  )::text;
`;

const phones = [
  "16045550501", "16045550502", "16045550503",
  "16045550504", "16045550505",
];

const cleanup = async () => {
  await runSql(`
    delete from public.client_profiles where phone = any(array[
      ${phones.map((phone) => `'${phone}'`).join(",")}
    ]::text[]);
    delete from public.salons where id = '${ids.salon}';
    delete from public.service_categories where slug = 'group-pricing-concurrency';
  `);
};

try {
  await cleanup();
  await runSql(`
    insert into public.service_categories (slug, name_en, name_vi)
    values ('group-pricing-concurrency', 'Group concurrency', 'Group concurrency');
    insert into public.salons (
      id, slug, name, phone, timezone, currency_code, opening_hours, tax_lines,
      subscription_plan
    ) values (
      '${ids.salon}', 'group-pricing-concurrency', 'Group concurrency',
      '+16045550500', 'UTC', 'CAD',
      '{
        "sun":{"open":"00:00","close":"23:59","closed":false},
        "mon":{"open":"00:00","close":"23:59","closed":false},
        "tue":{"open":"00:00","close":"23:59","closed":false},
        "wed":{"open":"00:00","close":"23:59","closed":false},
        "thu":{"open":"00:00","close":"23:59","closed":false},
        "fri":{"open":"00:00","close":"23:59","closed":false},
        "sat":{"open":"00:00","close":"23:59","closed":false}
      }'::jsonb,
      '[{"name":"GST","rate":0.05,"enabled":true}]'::jsonb,
      'premium'
    );
    insert into public.services (
      id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
      category, is_addon, addon_timing
    ) values
      ('${ids.service}', '${ids.salon}', 'Main', 5000, 30, 10,
       'group-pricing-concurrency', false, 'sequential'),
      ('${ids.addon}', '${ids.salon}', 'Concurrent add-on', 1000, 15, 5,
       'group-pricing-concurrency', true, 'concurrent');
    insert into public.staff (id, salon_id, name, status)
    values
      ('${ids.staffA}', '${ids.salon}', 'Staff A', 'active'),
      ('${ids.staffB}', '${ids.salon}', 'Staff B', 'active');
    insert into public.staff_services (staff_id, service_id)
    values
      ('${ids.staffA}', '${ids.service}'), ('${ids.staffA}', '${ids.addon}'),
      ('${ids.staffB}', '${ids.service}'), ('${ids.staffB}', '${ids.addon}');
    insert into public.vouchers (
      id, salon_id, code, kind, amount_off_cents, max_uses,
      valid_from, expires_at
    ) values (
      '${ids.voucher}', '${ids.salon}', 'GROUP-LAST-ONE', 'promo', 300, 1,
      clock_timestamp() - interval '1 day', clock_timestamp() + interval '10 days'
    );
  `);

  const base = await runSql(`
    select (date_trunc('day', clock_timestamp()) + interval '3 days 9 hours')::text
  `);

  // Same-key parallel requests serialize to one write and one exact replay.
  const replayPayload = payloadAt(base, 0, "Replay");
  const replayQuote = await quote(replayPayload, null, phones[0]);
  assert.equal(replayQuote.success, true);
  const replayStatement = createSql(
    replayPayload, null, phones[0], ids.replayIdem,
    replayQuote.pricing_fingerprint,
  );
  const [replayA, replayB] = (
    await Promise.all([runSql(replayStatement), runSql(replayStatement)])
  ).map(lastJson);
  assert.equal(replayA.success, true);
  assert.equal(replayB.success, true);
  assert.deepEqual([replayA.idempotent, replayB.idempotent].sort(), [false, true]);
  assert.equal(replayA.group_id, replayB.group_id);
  assert.deepEqual(replayA.booking_ids, replayB.booking_ids);
  assert.deepEqual(replayA.pricing_snapshot, replayB.pricing_snapshot);
  assert.equal(await runSql(`
    select count(*) from public.bookings
    where salon_id = '${ids.salon}' and idempotency_key = '${ids.replayIdem}'
  `), "1");

  // Two accepted quotes race for the last unrestricted voucher use.
  const voucherPayloadA = payloadAt(base, 2, "Voucher A");
  const voucherPayloadB = payloadAt(base, 4, "Voucher B");
  const [voucherQuoteA, voucherQuoteB] = await Promise.all([
    quote(voucherPayloadA, ids.voucher, phones[1]),
    quote(voucherPayloadB, ids.voucher, phones[2]),
  ]);
  assert.equal(voucherQuoteA.success, true);
  assert.equal(voucherQuoteB.success, true);
  const [voucherRaceA, voucherRaceB] = (
    await Promise.all([
      runSql(createSql(voucherPayloadA, ids.voucher, phones[1], ids.voucherIdemA,
        voucherQuoteA.pricing_fingerprint)),
      runSql(createSql(voucherPayloadB, ids.voucher, phones[2], ids.voucherIdemB,
        voucherQuoteB.pricing_fingerprint)),
    ])
  ).map(lastJson);
  assert.deepEqual(
    [voucherRaceA.code, voucherRaceB.code].sort(),
    ["booked", "voucher_invalid"],
  );
  assert.equal(await runSql(`select used_count from public.vouchers where id = '${ids.voucher}'`), "1");
  assert.equal(await runSql(`
    select count(*) from public.voucher_redemptions where voucher_id = '${ids.voucher}'
  `), "1");
  assert.equal(await runSql(`
    select count(*) from public.bookings
    where salon_id = '${ids.salon}'
      and idempotency_key in ('${ids.voucherIdemA}', '${ids.voucherIdemB}')
  `), "1");
  const voucherLoserPhone = voucherRaceA.code === "voucher_invalid" ? phones[1] : phones[2];
  assert.equal(await runSql(`
    select count(*) from public.client_profiles where phone = '${voucherLoserPhone}'
  `), "0");

  // Different idempotency keys race for the same staff slots. Exclusion
  // violation rolls back the entire losing party, including its first member.
  const slotPayloadA = payloadAt(base, 6, "Slot A");
  const slotPayloadB = payloadAt(base, 6, "Slot B");
  const [slotQuoteA, slotQuoteB] = await Promise.all([
    quote(slotPayloadA, null, phones[3]),
    quote(slotPayloadB, null, phones[4]),
  ]);
  assert.equal(slotQuoteA.success, true);
  assert.equal(slotQuoteB.success, true);
  const [slotRaceA, slotRaceB] = (
    await Promise.all([
      runSql(createSql(slotPayloadA, null, phones[3], ids.slotIdemA,
        slotQuoteA.pricing_fingerprint)),
      runSql(createSql(slotPayloadB, null, phones[4], ids.slotIdemB,
        slotQuoteB.pricing_fingerprint)),
    ])
  ).map(lastJson);
  assert.deepEqual(
    [slotRaceA.code, slotRaceB.code].sort(),
    ["booked", "slot_conflict"],
  );
  const slotWinner = slotRaceA.code === "booked" ? slotRaceA : slotRaceB;
  const slotLoserPhone = slotRaceA.code === "slot_conflict" ? phones[3] : phones[4];
  assert.equal(await runSql(`
    select count(*) from public.bookings where group_id = '${slotWinner.group_id}'
  `), "2");
  assert.equal(await runSql(`
    select count(*) from public.client_profiles where phone = '${slotLoserPhone}'
  `), "0");

  console.log("public group booking pricing concurrency rehearsal: PASS");
} finally {
  await cleanup();
}
