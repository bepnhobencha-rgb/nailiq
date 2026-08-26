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

const salonId = "18100010-0000-4000-8000-000000000001";

async function sql(statement) {
  const { stdout } = await execFileAsync(
    process.env.PSQL_BIN ?? "psql",
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return stdout.trim();
}

function json(output) {
  const line = output.split("\n").findLast((value) => value.startsWith("{"));
  return line ? JSON.parse(line) : null;
}

async function cleanup() {
  await sql(`delete from public.salons where id='${salonId}'`);
}

try {
  await cleanup();
  await sql(`
    insert into public.salons(id,slug,name,phone,timezone,is_beta)
    values('${salonId}','reactivation-concurrency-qa',
      'Reactivation Concurrency QA','+16045551810','UTC',true)
  `);

  const createSql = `
    select row_to_json(result)::text
    from public.create_reactivation_campaign_draft(
      '${salonId}','winback',date '2026-08-17',
      'Win-back campaign draft',
      'We would love to welcome you back when you are ready to visit.',
      'Tiệm rất mong được đón bạn quay lại khi bạn thấy thuận tiện.'
    ) result
  `;
  const results = (await Promise.all([sql(createSql), sql(createSql)])).map(json);
  assert.deepEqual(
    results.map((row) => row.outcome).sort(),
    ["created", "existing"],
  );
  assert.equal(
    new Set(results.map((row) => row.approval_request_id)).size,
    1,
  );
  assert.equal(
    await sql(`select count(*) from public.approval_requests
      where reactivation_campaign_claim_id in (
        select id from public.reactivation_campaign_draft_claims
        where salon_id='${salonId}'
      )`),
    "1",
  );

  process.stdout.write("PASS reactivation campaign draft concurrency\n");
} finally {
  await cleanup();
}
