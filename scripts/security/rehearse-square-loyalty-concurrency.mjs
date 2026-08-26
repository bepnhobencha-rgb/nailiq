#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const url = process.env.DB_URL;
const psql = process.env.PSQL_BIN ?? "psql";
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !url) {
  throw new Error("disposable local DB required");
}
const host = new URL(url).hostname;
if (!["", "localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
  throw new Error("non-local DB refused");
}
const run = async (sql) => (await runFile(
  psql,
  [url, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", sql],
  { encoding: "utf8", timeout: 30_000 },
)).stdout.trim();

const salon = "51251000-0000-4000-8000-000000000001";
const context = [
  "'merchant_loyalty_race'",
  "'application_loyalty_race'",
  "'sandbox'",
  "'2026-07-15'",
];

function accountMaterial(providerFingerprint, balance, lifetime, updatedAt) {
  return `jsonb_build_object(
    'merchant_id',${context[0]},'application_id',${context[1]},
    'environment',${context[2]},'api_version',${context[3]},
    'provider_account_fingerprint','${providerFingerprint}',
    'entity',jsonb_build_object(
      'id','account-race','program_id','program-race','balance',${balance},
      'lifetime_points',${lifetime},'updated_at','${updatedAt}'
    )
  )`;
}

try {
  await run(`
    delete from public.salons where id='${salon}';
    insert into public.salons(id,slug,name,phone,timezone,currency_code)
      values('${salon}','square-loyalty-race','Square loyalty race','+16045550126','UTC','CAD');
    insert into public.square_integrations(
      salon_id,merchant_id,location_id,application_id,access_token,
      environment,oauth_scopes,loyalty_sync_enabled
    ) values(
      '${salon}','merchant_loyalty_race','location_loyalty_race',
      'application_loyalty_race','secret','sandbox',
      array['LOYALTY_READ','LOYALTY_WRITE'],true
    );
    insert into public.platform_settings(id) values('platform') on conflict(id) do nothing;
    update public.platform_settings set square_loyalty_platform_enabled=true where id='platform';
  `);
  const rawFingerprint = await run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.square_feature_contract('${salon}','loyalty')->>'provider_account_fingerprint';
  `);
  const fingerprint = rawFingerprint.split("\n").at(-1);

  await run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.record_square_webhook_event(
      '${salon}','account-race-new','loyalty.account.updated','2026-08-22T16:00:02Z',
      'account-race',${accountMaterial(fingerprint, 20, 50, "2026-08-22T16:00:02Z")},repeat('a',64)
    );
    select public.record_square_webhook_event(
      '${salon}','account-race-old','loyalty.account.updated','2026-08-22T16:00:01Z',
      'account-race',${accountMaterial(fingerprint, 10, 40, "2026-08-22T16:00:01Z")},repeat('b',64)
    );
  `);
  const claimText = await run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select x::text from public.claim_square_webhook_events('loyalty',2) x;
  `);
  const claims = claimText.split("\n").filter((line) => line.startsWith("{")).map(JSON.parse);
  assert.equal(claims.length, 2);
  const apply = (claim) => run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.apply_square_loyalty_webhook_event(
      '${claim.inbox_id}','${claim.claim_token}'
    )::text;
  `);
  const results = await Promise.all(claims.map(apply));
  assert.equal(results.filter((value) => JSON.parse(value.split("\n").at(-1)).code === "loyalty_event_applied").length, 2);
  assert.equal(await run(`
    select balance||':'||lifetime_points||':'||state
    from public.square_loyalty_account_mirrors
    where salon_id='${salon}' and square_account_id='account-race';
  `), "20:50:active");
  assert.equal(await run(`
    select count(*) from public.square_webhook_inbox
    where salon_id='${salon}' and status='processed';
  `), "2");
  console.log("square loyalty concurrency passed");
} finally {
  await run(`
    alter table public.square_loyalty_event_mirrors
      disable trigger reject_square_loyalty_event_mutation;
    delete from public.square_loyalty_event_mirrors where salon_id='${salon}';
    alter table public.square_loyalty_event_mirrors
      enable trigger reject_square_loyalty_event_mutation;
    delete from public.square_loyalty_reward_mirrors where salon_id='${salon}';
    delete from public.square_loyalty_account_mirrors where salon_id='${salon}';
    delete from public.salons where id='${salon}';
    update public.platform_settings set square_loyalty_platform_enabled=false where id='platform';
  `).catch(() => {});
}
