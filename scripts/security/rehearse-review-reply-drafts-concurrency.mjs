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

const salonId = "17800010-0000-4000-8000-000000000001";
const reviewKey = "c".repeat(64);

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
    values('${salonId}','review-reply-concurrency-qa',
      'Review Reply Concurrency QA','+16045551810','UTC',true)
  `);

  const claimSql = `
    select row_to_json(result)::text
    from public.claim_review_reply_draft(
      '${salonId}','google','${reviewKey}','${reviewKey}'
    ) result
  `;
  const claims = (await Promise.all([sql(claimSql), sql(claimSql)])).map(json);
  assert.deepEqual(
    claims.map((row) => row.outcome).sort(),
    ["claimed", "in_progress"],
  );
  const winner = claims.find((row) => row.outcome === "claimed");
  assert.ok(winner?.claim_id && winner?.claim_token);

  const completeSql = `
    select row_to_json(result)::text
    from public.complete_review_reply_draft(
      '${winner.claim_id}','${winner.claim_token}','QA Guest',5,
      'Excellent service.',
      'Thank you for sharing your experience. We look forward to welcoming you again.',
      'en'
    ) result
  `;
  const completions = (
    await Promise.all([sql(completeSql), sql(completeSql)])
  ).map(json);
  assert.deepEqual(
    completions.map((row) => row.outcome).sort(),
    ["created", "existing"],
  );
  assert.equal(
    new Set(completions.map((row) => row.approval_request_id)).size,
    1,
  );
  assert.equal(
    await sql(`select count(*) from public.approval_requests
      where review_reply_claim_id='${winner.claim_id}'`),
    "1",
  );

  process.stdout.write("PASS review reply draft concurrency\n");
} finally {
  await cleanup();
}
