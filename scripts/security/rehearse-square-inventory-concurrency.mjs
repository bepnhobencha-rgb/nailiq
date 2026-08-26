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

const salon = "51271000-0000-4000-8000-000000000001";

function context(fingerprint, body) {
  return `jsonb_build_object(
    'merchant_id','merchant_inventory_race',
    'application_id','application_inventory_race',
    'environment','sandbox','api_version','2026-07-15',
    'provider_account_fingerprint','${fingerprint}',
    ${body}
  )`;
}

function count(quantity, calculatedAt) {
  return context("FINGERPRINT", `'counts',jsonb_build_array(jsonb_build_object(
    'catalog_object_id','variation-race','catalog_object_type','ITEM_VARIATION',
    'location_id','location_inventory_race','quantity','${quantity}',
    'state','IN_STOCK','calculated_at','${calculatedAt}'
  ))`);
}

try {
  await run(`
    delete from public.salons where id='${salon}';
    insert into public.salons(id,slug,name,phone,timezone,currency_code)
      values('${salon}','square-inventory-race','Square inventory race','+16045550128','UTC','CAD');
    insert into public.square_integrations(
      salon_id,merchant_id,location_id,application_id,access_token,
      environment,enabled,oauth_scopes,inventory_sync_enabled
    ) values(
      '${salon}','merchant_inventory_race','location_inventory_race',
      'application_inventory_race','secret','sandbox',true,
      array['INVENTORY_READ','INVENTORY_WRITE','ITEMS_READ'],true
    );
    insert into public.platform_settings(id) values('platform') on conflict(id) do nothing;
    update public.platform_settings set square_inventory_platform_enabled=true where id='platform';
  `);
  const rawFingerprint = await run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.square_feature_contract('${salon}','inventory')->>'provider_account_fingerprint';
  `);
  const fingerprint = rawFingerprint.split("\n").at(-1);
  const oldCount = count("9", "2026-08-22T17:00:00Z").replace("FINGERPRINT", fingerprint);
  const newCount = count("15", "2026-08-22T17:02:00Z").replace("FINGERPRINT", fingerprint);

  await run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.record_square_webhook_event(
      '${salon}','inventory-race-old','inventory.count.updated','2026-08-22T17:00:01Z',
      'inventory-race-old',${oldCount},repeat('a',64)
    );
    select public.record_square_webhook_event(
      '${salon}','inventory-race-new','inventory.count.updated','2026-08-22T17:02:01Z',
      'inventory-race-new',${newCount},repeat('b',64)
    );
    select public.record_square_webhook_event(
      '${salon}','catalog-race-old','catalog.version.updated','2026-08-22T17:01:01Z',
      'merchant_inventory_race',${context(fingerprint, "'catalog_updated_at','2026-08-22T17:01:00Z'")},repeat('c',64)
    );
    select public.record_square_webhook_event(
      '${salon}','catalog-race-new','catalog.version.updated','2026-08-22T17:03:01Z',
      'merchant_inventory_race',${context(fingerprint, "'catalog_updated_at','2026-08-22T17:03:00Z'")},repeat('d',64)
    );
  `);
  const claimText = await run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select x::text from public.claim_square_webhook_events('inventory',4) x;
  `);
  const claims = claimText.split("\n").filter((line) => line.startsWith("{")).map(JSON.parse);
  assert.equal(claims.length, 4);
  const apply = (claim) => run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.apply_square_inventory_webhook_event(
      '${claim.inbox_id}','${claim.claim_token}'
    )::text;
  `);
  const results = await Promise.all(claims.map(apply));
  assert.equal(results.filter((value) => (
    JSON.parse(value.split("\n").at(-1)).code === "inventory_event_applied"
  )).length, 4);
  assert.equal(await run(`
    select quantity::text from public.square_inventory_count_mirrors
    where salon_id='${salon}' and square_catalog_variation_id='variation-race'
      and inventory_state='IN_STOCK';
  `), "15.00000");
  assert.equal(await run(`
    select count(*) from public.square_inventory_count_event_mirrors
    where salon_id='${salon}';
  `), "2");
  assert.equal(await run(`
    select refresh_required::text||':'||refresh_required_since::text
    from public.square_inventory_catalog_sync_state where salon_id='${salon}';
  `), "true:2026-08-22 17:03:00+00");
  assert.equal(await run(`
    select count(*) from public.square_webhook_inbox
    where salon_id='${salon}' and status='processed';
  `), "4");
  console.log("square inventory concurrency passed");
} finally {
  await run(`
    delete from public.square_inventory_count_mirrors where salon_id='${salon}';
    alter table public.square_inventory_count_event_mirrors
      disable trigger reject_square_inventory_count_event_mutation;
    delete from public.square_inventory_count_event_mirrors where salon_id='${salon}';
    alter table public.square_inventory_count_event_mirrors
      enable trigger reject_square_inventory_count_event_mutation;
    delete from public.square_inventory_catalog_sync_state where salon_id='${salon}';
    delete from public.salons where id='${salon}';
    update public.platform_settings set square_inventory_platform_enabled=false where id='platform';
  `).catch(() => {});
}
