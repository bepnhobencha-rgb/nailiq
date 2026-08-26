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

const salon = "51252000-0000-4000-8000-000000000001";

function context(fingerprint, entity) {
  return `jsonb_build_object(
    'merchant_id','merchant_gift_race',
    'application_id','application_gift_race',
    'environment','sandbox','api_version','2026-07-15',
    'provider_account_fingerprint','${fingerprint}',
    'entity',${entity}
  )`;
}

function card(balance, state = "ACTIVE") {
  return `jsonb_build_object(
    'id','gftc:race','type','DIGITAL','gan_source','SQUARE','state','${state}',
    'balance_money',jsonb_build_object('amount',${balance},'currency','CAD'),
    'created_at','2026-08-22T16:59:00Z'
  )`;
}

function redeem(status) {
  return `jsonb_build_object(
    'id','gcact:race','type','REDEEM','location_id','location_gift_race',
    'gift_card_id','gftc:race','created_at','2026-08-22T17:01:00Z',
    'status','${status}',
    'gift_card_balance_money',jsonb_build_object('amount',3750,'currency','CAD'),
    'amount_money',jsonb_build_object('amount',1250,'currency','CAD'),
    'payment_id','payment-race'
  )`;
}

try {
  await run(`
    delete from public.salons where id='${salon}';
    insert into public.salons(id,slug,name,phone,timezone,currency_code)
      values('${salon}','square-gift-race','Square gift race','+16045550127','UTC','CAD');
    insert into public.square_integrations(
      salon_id,merchant_id,location_id,application_id,access_token,
      environment,oauth_scopes,gift_cards_sync_enabled
    ) values(
      '${salon}','merchant_gift_race','location_gift_race',
      'application_gift_race','secret','sandbox',
      array['GIFTCARDS_READ','GIFTCARDS_WRITE','PAYMENTS_WRITE'],true
    );
    insert into public.platform_settings(id) values('platform') on conflict(id) do nothing;
    update public.platform_settings set square_gift_cards_platform_enabled=true where id='platform';
  `);
  const rawFingerprint = await run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.square_feature_contract('${salon}','gift_cards')->>'provider_account_fingerprint';
  `);
  const fingerprint = rawFingerprint.split("\n").at(-1);

  await run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.record_square_webhook_event(
      '${salon}','gift-card-new','gift_card.updated','2026-08-22T17:00:30Z',
      'gftc:race',${context(fingerprint, card(5000))},repeat('a',64)
    );
    select public.record_square_webhook_event(
      '${salon}','gift-card-old','gift_card.created','2026-08-22T17:00:00Z',
      'gftc:race',${context(fingerprint, card(0, "PENDING"))},repeat('b',64)
    );
    select public.record_square_webhook_event(
      '${salon}','gift-redeem-pending','gift_card.activity.created','2026-08-22T17:01:30Z',
      'gcact:race',${context(fingerprint, redeem("PENDING"))},repeat('c',64)
    );
    select public.record_square_webhook_event(
      '${salon}','gift-redeem-completed','gift_card.activity.updated','2026-08-22T17:02:00Z',
      'gcact:race',${context(fingerprint, redeem("COMPLETED"))},repeat('d',64)
    );
  `);
  const claimText = await run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select x::text from public.claim_square_webhook_events('gift_cards',4) x;
  `);
  const claims = claimText.split("\n").filter((line) => line.startsWith("{")).map(JSON.parse);
  assert.equal(claims.length, 4);
  const apply = (claim) => run(`
    select set_config('request.jwt.claim.role','service_role',true);
    select public.apply_square_gift_card_webhook_event(
      '${claim.inbox_id}','${claim.claim_token}'
    )::text;
  `);
  const results = await Promise.all(claims.map(apply));
  assert.equal(results.filter((value) => JSON.parse(value.split("\n").at(-1)).code === "gift_card_event_applied").length, 4);
  assert.equal(await run(`
    select state||':'||balance_cents||':'||currency
    from public.square_gift_card_mirrors
    where salon_id='${salon}' and square_gift_card_id='gftc:race';
  `), "ACTIVE:3750:CAD");
  assert.equal(await run(`
    select string_agg(activity_status,',' order by webhook_occurred_at)
    from public.square_gift_card_activity_mirrors
    where salon_id='${salon}' and square_activity_id='gcact:race';
  `), "PENDING,COMPLETED");
  assert.equal(await run(`
    select count(*) from public.square_webhook_inbox
    where salon_id='${salon}' and status='processed';
  `), "4");
  console.log("square gift card concurrency passed");
} finally {
  await run(`
    alter table public.square_gift_card_activity_mirrors
      disable trigger reject_square_gift_card_activity_mutation;
    delete from public.square_gift_card_activity_mirrors where salon_id='${salon}';
    alter table public.square_gift_card_activity_mirrors
      enable trigger reject_square_gift_card_activity_mutation;
    delete from public.square_gift_card_mirrors where salon_id='${salon}';
    delete from public.salons where id='${salon}';
    update public.platform_settings set square_gift_cards_platform_enabled=false where id='platform';
  `).catch(() => {});
}
