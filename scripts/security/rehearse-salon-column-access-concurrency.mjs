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
const hostname = new URL(dbUrl).hostname;
if (!["", "localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) {
  throw new Error(`Refusing non-local database host: ${hostname}`);
}

const run = async (sql) =>
  (
    await execFileAsync(
      psql,
      [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    )
  ).stdout.trim();

const salonId = "51100000-0000-4000-8000-000000000101";
const ownerId = "51100000-0000-4000-8000-000000000102";
const sessionId = "51100000-0000-4000-8000-000000000103";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const authSql = `
  set local role authenticated;
  select set_config(
    'request.jwt.claim',
    jsonb_build_object(
      'role','authenticated','aud','authenticated','sub','${ownerId}',
      'session_id','${sessionId}',
      'exp',floor(extract(epoch from statement_timestamp()))::bigint + 600
    )::text,
    true
  );
  select set_config('request.jwt.claim.role','authenticated',true);
  select set_config('request.jwt.claim.sub','${ownerId}',true);
`;
const jsonFrom = (output) => {
  const line = output
    .split("\n")
    .filter((candidate) => candidate.startsWith("{"))
    .at(-1);
  assert.ok(line, `missing JSON result in output: ${output}`);
  return JSON.parse(line);
};

const cleanup = async () => {
  await run(`
    delete from public.salons where id='${salonId}';
    delete from auth.users where id='${ownerId}';
  `).catch(() => {});
};

try {
  await cleanup();
  await run(`
    insert into auth.users(id,email,created_at)
      values('${ownerId}','salon-column-race@nailiq.invalid',now());
    insert into auth.sessions(id,user_id,created_at,updated_at)
      values('${sessionId}','${ownerId}',now(),now());
    insert into public.salons(id,slug,name,phone,email,timezone)
      values('${salonId}','salon-column-race','Salon column race',
        '+16045550112','race-owner@example.test','UTC');
    insert into public.salon_members(salon_id,user_id,role)
      values('${salonId}','${ownerId}','owner');
  `);

  // A downgrade that owns the membership row lock must complete before the
  // loader can authorize. The loader then sees the new lower role and denies.
  const downgradeFirst = run(`
    begin;
    update public.salon_members set role='receptionist'
      where salon_id='${salonId}' and user_id='${ownerId}';
    select pg_sleep(0.8);
    commit;
  `);
  await sleep(150);
  const deniedAfterDowngrade = run(`
    begin;
    ${authSql}
    select public.load_salon_owner_admin_settings('${salonId}')::text;
    commit;
  `);
  const [, deniedOutput] = await Promise.all([
    downgradeFirst,
    deniedAfterDowngrade,
  ]);
  assert.equal(jsonFrom(deniedOutput).code, "forbidden");

  await run(`update public.salon_members set role='owner'
    where salon_id='${salonId}' and user_id='${ownerId}'`);

  // Conversely, a loader that acquires FOR SHARE first returns one complete
  // authorized snapshot. The downgrade waits for that transaction to end.
  const authorizedFirst = run(`
    begin;
    ${authSql}
    select public.load_salon_owner_admin_settings('${salonId}')::text;
    select pg_sleep(0.8);
    commit;
  `);
  await sleep(150);
  const downgradeStartedAt = Date.now();
  const downgradeAfterLoader = run(`
    update public.salon_members set role='receptionist'
      where salon_id='${salonId}' and user_id='${ownerId}'
    returning role;
  `);
  const [authorizedOutput, downgradedRole] = await Promise.all([
    authorizedFirst,
    downgradeAfterLoader,
  ]);
  assert.equal(jsonFrom(authorizedOutput).code, "loaded");
  assert.equal(downgradedRole.split("\n").at(-1), "receptionist");
  assert.ok(
    Date.now() - downgradeStartedAt >= 500,
    "membership downgrade did not serialize behind the loader share lock",
  );

  const finalDenied = jsonFrom(
    await run(`
      begin;
      ${authSql}
      select public.load_salon_owner_admin_settings('${salonId}')::text;
      commit;
    `),
  );
  assert.equal(finalDenied.code, "forbidden");

  console.log("salon column access concurrency passed");
} finally {
  await cleanup();
}
