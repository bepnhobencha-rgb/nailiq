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
const localHosts = new Set(["", "localhost", "127.0.0.1", "[::1]", "::1"]);
if (!localHosts.has(parsedUrl.hostname)) {
  throw new Error(`Refusing non-local database host: ${parsedUrl.hostname}`);
}

const salon = "a2000000-0000-4000-8000-000000000001";
const service = "a2000000-0000-4000-8000-000000000002";
const addon = "a2000000-0000-4000-8000-000000000003";
const staff = "a2000000-0000-4000-8000-000000000004";
const idem = "a2000000-0000-4000-8000-000000000005";
const raceIdem = "a2000000-0000-4000-8000-000000000006";
const voucher = "a2000000-0000-4000-8000-000000000007";
const phone = "16045550299";

const runSql = async (statement) => {
  const { stdout } = await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 20_000 },
  );
  return stdout.trim();
};

const lastJson = (output) => {
  const line = output.split("\n").filter(Boolean).at(-1);
  return JSON.parse(line);
};

const cleanup = async () => {
  await runSql(`
    delete from public.client_profiles where phone = '${phone}';
    delete from public.salons where id = '${salon}';
    delete from public.service_categories where slug = 'pricing-concurrency';
  `);
};

try {
  await cleanup();
  await runSql(`
    insert into public.service_categories (slug, name_en, name_vi)
    values ('pricing-concurrency', 'Pricing concurrency', 'Pricing concurrency');

    insert into public.salons (
      id, slug, name, phone, timezone, currency_code, opening_hours, tax_lines
    ) values (
      '${salon}', 'pricing-concurrency', 'Pricing concurrency', '+16045550200',
      'UTC', 'CAD',
      '{
        "sun":{"open":"00:00","close":"23:59","closed":false},
        "mon":{"open":"00:00","close":"23:59","closed":false},
        "tue":{"open":"00:00","close":"23:59","closed":false},
        "wed":{"open":"00:00","close":"23:59","closed":false},
        "thu":{"open":"00:00","close":"23:59","closed":false},
        "fri":{"open":"00:00","close":"23:59","closed":false},
        "sat":{"open":"00:00","close":"23:59","closed":false}
      }'::jsonb,
      '[{"name":"GST","rate":0.05,"enabled":true}]'::jsonb
    );

    insert into public.services (
      id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
      category, is_addon, addon_timing
    ) values
      ('${service}', '${salon}', 'Main', 5000, 30, 10,
       'pricing-concurrency', false, 'sequential'),
      ('${addon}', '${salon}', 'Concurrent add-on', 1000, 15, 5,
       'pricing-concurrency', true, 'concurrent');

    insert into public.staff (id, salon_id, name, status)
    values ('${staff}', '${salon}', 'Active staff', 'active');
    insert into public.staff_services (staff_id, service_id)
    values ('${staff}', '${service}'), ('${staff}', '${addon}');

    insert into public.vouchers (
      id, salon_id, code, kind, client_phone, amount_off_cents,
      max_uses, valid_from, expires_at
    ) values (
      '${voucher}', '${salon}', 'CONCURRENCY100', 'promo', '${phone}', 100,
      5, clock_timestamp() - interval '1 day',
      clock_timestamp() + interval '10 days'
    );
  `);

  const timing = await runSql(`
    select concat_ws('|',
      (date_trunc('day', clock_timestamp()) + interval '2 days 12 hours')::text,
      (date_trunc('day', clock_timestamp()) + interval '2 days 12 hours 40 minutes')::text
    )
  `);
  const [start, end] = timing.split("|");

  const quote = lastJson(await runSql(`
    select set_config('request.jwt.claim.role', 'service_role', true);
    select public.quote_public_booking(
      '${salon}', '${service}', '${staff}', '${start}', '${end}',
      array['${addon}'::uuid], null, null, '${phone}', null, false
    )::text;
  `));
  assert.equal(quote.success, true);
  assert.match(quote.pricing_fingerprint, /^[0-9a-f]{64}$/);

  const createSql = `
    select set_config('request.jwt.claim.role', 'service_role', true);
    select public.create_public_booking(
      '${salon}', '${service}', '${staff}', 'Concurrency Guest', '${phone}',
      '${start}', '${end}', 'confirmed', 'same payload',
      array['${addon}'::uuid], null, null, null, null, false,
      '${idem}', '${quote.pricing_fingerprint}'
    )::text;
  `;

  const [first, second] = (
    await Promise.all([runSql(createSql), runSql(createSql)])
  ).map(lastJson);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.deepEqual(
    [first.idempotent, second.idempotent].sort(),
    [false, true],
  );
  assert.equal(first.booking_id, second.booking_id);

  const persisted = await runSql(`
    select concat_ws('|',
      (select count(*) from public.bookings
        where salon_id = '${salon}' and idempotency_key = '${idem}'),
      (select visit_count from public.client_profiles where phone = '${phone}'),
      (select count(*) from public.booking_addons
        where booking_id = '${first.booking_id}' and service_id = '${addon}')
    )
  `);
  assert.equal(persisted, "1|1|1");

  const raceQuote = lastJson(await runSql(`
    select set_config('request.jwt.claim.role', 'service_role', true);
    select public.quote_public_booking(
      '${salon}', '${service}', '${staff}',
      '${start}'::timestamptz + interval '2 hours',
      '${end}'::timestamptz + interval '2 hours',
      array[]::uuid[], null, '${voucher}', '${phone}', null, false
    )::text;
  `));
  assert.equal(raceQuote.success, true);

  const newVoucherCreate = `
    select set_config('request.jwt.claim.role', 'service_role', true);
    select public.create_public_booking(
      '${salon}', '${service}', '${staff}', 'New Lock Order', '${phone}',
      '${start}'::timestamptz + interval '2 hours',
      '${end}'::timestamptz + interval '2 hours',
      'confirmed', 'new lock order', array[]::uuid[], null, null, null,
      '${voucher}', false, '${raceIdem}', '${raceQuote.pricing_fingerprint}'
    )::text;
  `;
  const legacyCreate = `
    select set_config('request.jwt.claim.role', 'service_role', true);
    select public.create_public_booking(
      '${salon}', '${service}', '${staff}', 'Legacy Lock Order', '${phone}',
      '${start}'::timestamptz + interval '4 hours',
      '${end}'::timestamptz + interval '4 hours',
      'confirmed', 1, 'legacy lock order', null, 1, null, null
    )::text;
  `;
  const [newRace, legacyRace] = (
    await Promise.all([runSql(newVoucherCreate), runSql(legacyCreate)])
  ).map(lastJson);
  assert.equal(newRace.success, true);
  assert.equal(legacyRace.success, true);
  assert.equal(
    await runSql(`
      select price_cents from public.bookings
      where id = '${legacyRace.booking_id}'
    `),
    "5000",
  );
  assert.equal(
    await runSql(`select used_count from public.vouchers where id = '${voucher}'`),
    "1",
  );

  const claimSql = `
    select set_config('request.jwt.claim.role', 'service_role', true);
    select public.claim_owner_booking_notification(
      '${salon}', '${first.booking_id}', 'new', 'owner@example.test', 'created'
    )::text;
  `;
  const [claimA, claimB] = (
    await Promise.all([runSql(claimSql), runSql(claimSql)])
  ).map(lastJson);
  assert.deepEqual(
    [claimA.claimed, claimB.claimed].sort(),
    [false, true],
  );
  assert.equal(claimA.claim_id, claimB.claim_id);
  assert.equal(
    await runSql(`
      select count(*) from public.owner_booking_notification_claims
      where booking_id = '${first.booking_id}'
        and event_type = 'new'
        and recipient_identity = 'owner@example.test'
        and event_occurrence_key = 'created'
    `),
    "1",
  );

  process.stdout.write(
    "PASS public booking idempotency, legacy/new lock order, and owner notification claim concurrency\n",
  );
} finally {
  await cleanup();
}
