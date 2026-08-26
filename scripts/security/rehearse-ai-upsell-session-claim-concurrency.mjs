#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dbUrl = process.env.DB_URL;
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !dbUrl) {
  throw new Error("Refusing without NAILIQ_DISPOSABLE_DB=1 and DB_URL");
}
const host = new URL(dbUrl).hostname;
if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  throw new Error(`Refusing non-local database host: ${host}`);
}

const psql = process.env.PSQL_BIN ?? "psql";
const salonA = "17500010-0000-4000-8000-000000000001";
const salonB = "17500010-0000-4000-8000-000000000002";
const selectedA = "17500010-0000-4000-8000-000000000011";
const addonA = "17500010-0000-4000-8000-000000000012";
const selectedB = "17500010-0000-4000-8000-000000000021";
const addonB = "17500010-0000-4000-8000-000000000022";
const otpA = "17500010-0000-4000-8000-000000000031";
const otpB = "17500010-0000-4000-8000-000000000032";
const session = "17500010-0000-4000-8000-000000000040";
const category = "upsell-claim-concurrency-qa";

async function sql(statement) {
  const { stdout } = await execFileAsync(
    psql,
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return stdout.trim();
}

function json(output) {
  const line = output.split("\n").findLast((value) => value.startsWith("{"));
  assert.ok(line, `expected JSON row, received: ${output}`);
  return JSON.parse(line);
}

function claimSql({ salonId, otpId, phone, selectedId, addonId }) {
  return `
    set role service_role;
    select row_to_json(result)::text
    from public.claim_ai_upsell_offer(
      '${salonId}','${session}','${otpId}','${phone}',
      '${selectedId}','${addonId}',
      'You usually add this (100% of your visits)',1
    ) result;
  `;
}

async function cleanup() {
  await sql(`delete from public.salons where id in ('${salonA}','${salonB}')`);
  await sql(`delete from public.service_categories where slug='${category}'`);
}

try {
  await cleanup();
  await sql(`
    insert into public.salons(id,slug,name,phone,timezone,is_beta) values
      ('${salonA}','upsell-claim-concurrency-a',
       'Upsell Claim Concurrency A','+16045551761','UTC',true),
      ('${salonB}','upsell-claim-concurrency-b',
       'Upsell Claim Concurrency B','+16045551762','UTC',true);
    insert into public.service_categories(slug,name_en,name_vi)
    values('${category}','Upsell claim concurrency QA','Upsell claim concurrency QA');
    insert into public.services(
      id,salon_id,name,price_cents,duration_minutes,buffer_minutes,
      category,deleted_at,is_addon,addon_timing
    ) values
      ('${selectedA}','${salonA}','Main service A',5000,45,10,
       '${category}',null,false,'sequential'),
      ('${addonA}','${salonA}','Add-on A',1200,20,5,
       '${category}',null,true,'sequential'),
      ('${selectedB}','${salonB}','Main service B',5500,45,10,
       '${category}',null,false,'sequential'),
      ('${addonB}','${salonB}','Add-on B',1300,20,5,
       '${category}',null,true,'sequential');
    insert into public.phone_otp_sessions(id,phone,salon_id,expires_at) values
      ('${otpA}','16045551761','${salonA}',now()+interval '15 minutes'),
      ('${otpB}','16045551762','${salonB}',now()+interval '15 minutes')
  `);

  const exactClaim = claimSql({
    salonId: salonA,
    otpId: otpA,
    phone: "16045551761",
    selectedId: selectedA,
    addonId: addonA,
  });
  // Hold transaction A open after its claim. Transaction B starts while A's
  // unique salon/session row is still uncommitted, so this deterministically
  // exercises PostgreSQL's conflicting-insert wait before returning replayed.
  const transactionA = `
    begin;
    ${exactClaim.replace("set role service_role;", "set local role service_role;")}
    select pg_sleep(1);
    commit
  `;
  const transactionB = `select pg_sleep(0.2); ${exactClaim}`;
  const claims = (
    await Promise.all([sql(transactionA), sql(transactionB)])
  ).map(json);
  assert.deepEqual(
    claims.map((row) => row.outcome).sort(),
    ["claimed", "replayed"],
  );
  assert.equal(new Set(claims.map((row) => row.claim_id)).size, 1);
  assert.equal(new Set(claims.map((row) => row.upsell_log_id)).size, 1);
  assert.deepEqual(claims[0].offer_payload, claims[1].offer_payload);
  assert.equal(
    await sql(`select count(*) from public.ai_upsell_session_claims
      where salon_id='${salonA}' and session_id='${session}'`),
    "1",
  );
  assert.equal(
    await sql(`select count(*) from public.ai_upsell_log
      where salon_id='${salonA}' and session_id='${session}' and outcome='shown'`),
    "1",
  );

  const tenantB = json(await sql(claimSql({
    salonId: salonB,
    otpId: otpB,
    phone: "16045551762",
    selectedId: selectedB,
    addonId: addonB,
  })));
  assert.equal(tenantB.outcome, "claimed");
  assert.notEqual(tenantB.claim_id, claims[0].claim_id);
  assert.equal(tenantB.offer_payload.service_id, addonB);
  assert.equal(
    await sql(`select count(*) from public.ai_upsell_session_claims
      where session_id='${session}'`),
    "2",
  );

  process.stdout.write("PASS AI upsell session claim concurrency\n");
} finally {
  await cleanup();
}
