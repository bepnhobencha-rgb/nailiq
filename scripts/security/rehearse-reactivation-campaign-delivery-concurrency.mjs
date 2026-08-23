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

const ids = {
  salon: "18110010-0000-4000-8000-000000000001",
  profile: "18110010-0000-4000-8000-000000000011",
  appendProfile: "18110010-0000-4000-8000-000000000012",
  sourceApproval: "18110010-0000-4000-8000-000000000021",
  sourceJob: "18110010-0000-4000-8000-000000000022",
  manifest: "18110010-0000-4000-8000-000000000031",
  releaseApproval: "18110010-0000-4000-8000-000000000041",
  releaseJob: "18110010-0000-4000-8000-000000000042",
  preflight: "18110010-0000-4000-8000-000000000051",
  plan: "18110010-0000-4000-8000-000000000061",
};
const audienceFingerprint = "5b041605992169ba2447caf1";
const preflightFingerprint =
  "7d38b1bc720a528cff2357480140107980b8929e9407d3edc6b72f6d1eabb9de";
const backupTable = "public.mqa0181_platform_settings_backup";

async function sql(statement) {
  const { stdout } = await execFileAsync(
    process.env.PSQL_BIN ?? "psql",
    [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-Atq", "-c", statement],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return stdout.trim();
}

function jsonRows(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

async function cleanup() {
  await sql(`
    do $cleanup$
    begin
      if to_regclass('${backupTable}') is not null then
        update public.platform_settings settings set
          sms_consent_hash_secret = backup.sms_consent_hash_secret,
          sms_consent_hash_key_id = backup.sms_consent_hash_key_id
        from ${backupTable} backup
        where settings.id = 'platform';
        execute 'drop table ${backupTable}';
      end if;
      delete from public.salons where id = '${ids.salon}';
      delete from public.client_profiles
       where id in ('${ids.profile}','${ids.appendProfile}');
    end;
    $cleanup$;
  `);
}

const setupSql = `
  create table ${backupTable} (
    sms_consent_hash_secret text,
    sms_consent_hash_key_id uuid
  );
  insert into ${backupTable}
    select sms_consent_hash_secret, sms_consent_hash_key_id
      from public.platform_settings where id='platform';
  update public.platform_settings set
    sms_consent_hash_secret=repeat('r',48),
    sms_consent_hash_key_id='18110010-0000-4000-8000-000000000099'
  where id='platform';

  insert into public.salons(
    id,slug,name,phone,timezone,is_beta,customer_channel,
    sms_outbound_enabled,email_outbound_enabled,sms_a2p_registered,
    subscription_status
  ) values(
    '${ids.salon}','reactivation-delivery-concurrency-qa',
    'Reactivation Delivery Concurrency QA','+16045551921','UTC',true,
    'email_only',false,true,false,'active'
  );
  insert into public.client_profiles(
    id,phone,name,email,marketing_email_consent_at
  ) values(
    '${ids.profile}','16045551922','Concurrency QA',
    'delivery-concurrency@nailiq.invalid',transaction_timestamp()
  ),(
    '${ids.appendProfile}','16045551923','Append Race QA',
    'delivery-append-race@nailiq.invalid',transaction_timestamp()
  );
  insert into public.salon_clients(salon_id,client_profile_id,source)
  values('${ids.salon}','${ids.profile}','manual');
  insert into public.customer_preferences(
    client_profile_id,salon_id,preferred_language,
    preferred_communication_channel,consent_marketing_sms,
    consent_marketing_email
  ) values('${ids.profile}','${ids.salon}','en','email',false,true);

  insert into public.approval_requests(
    id,salon_id,action_type,summary,payload,status,decided_at,expires_at
  ) values(
    '${ids.sourceApproval}','${ids.salon}','bulk_message','Source',
    jsonb_build_object('proposal_source','reactivation_campaign',
      'reactivation_kind','winback','dispatch_enabled',false,
      'no_messages_sent',true),
    'approved',transaction_timestamp(),transaction_timestamp()+interval '1 hour'
  );
  insert into public.ai_execution_jobs(
    id,salon_id,approval_request_id,action_type,payload,status,
    idempotency_key,result
  ) values(
    '${ids.sourceJob}','${ids.salon}','${ids.sourceApproval}','bulk_message',
    jsonb_build_object('proposal_source','reactivation_campaign',
      'reactivation_kind','winback','dispatch_enabled',false,
      'no_messages_sent',true),
    'waiting_input','mqa0181-concurrency-source',
    jsonb_build_object('blocker','release_approval_required',
      'dispatch_enabled',false,'no_messages_sent',true)
  );
  insert into public.ai_campaign_manifests(
    id,salon_id,source_execution_job_id,source_approval_request_id,
    audience_fingerprint,message_sha256,message,summary
  ) values(
    '${ids.manifest}','${ids.salon}','${ids.sourceJob}',
    '${ids.sourceApproval}','${audienceFingerprint}',repeat('3',64),
    '{"en":"QA","vi":"QA"}',
    jsonb_build_object('reactivation_kind','winback','no_messages_sent',true)
  );
  insert into public.ai_campaign_manifest_recipients(
    manifest_id,salon_id,client_profile_id,sms,email
  ) values('${ids.manifest}','${ids.salon}','${ids.profile}',false,true);

  insert into public.approval_requests(
    id,salon_id,action_type,summary,payload,status,decided_at,
    expires_at,release_manifest_id
  ) values(
    '${ids.releaseApproval}','${ids.salon}','bulk_message','Release',
    jsonb_build_object('proposal_source','reactivation_campaign_release_gate',
      'reactivation_kind','winback','manifest_id','${ids.manifest}',
      'source_execution_job_id','${ids.sourceJob}',
      'audience_fingerprint','${audienceFingerprint}',
      'message_sha256',repeat('3',64),
      'dispatch_enabled',false,'no_messages_sent',true),
    'approved',transaction_timestamp(),transaction_timestamp()+interval '1 hour',
    '${ids.manifest}'
  );
  insert into public.ai_execution_jobs(
    id,salon_id,approval_request_id,action_type,payload,status,
    idempotency_key,result
  ) values(
    '${ids.releaseJob}','${ids.salon}','${ids.releaseApproval}','bulk_message',
    jsonb_build_object('proposal_source','reactivation_campaign_release_gate',
      'reactivation_kind','winback','manifest_id','${ids.manifest}',
      'source_execution_job_id','${ids.sourceJob}',
      'audience_fingerprint','${audienceFingerprint}',
      'message_sha256',repeat('3',64),
      'dispatch_enabled',false,'no_messages_sent',true),
    'waiting_input','mqa0181-concurrency-release',
    jsonb_build_object('blocker','dispatch_not_enabled',
      'dispatch_plan_id','${ids.plan}','dispatch_enabled',false,
      'no_messages_sent',true)
  );
  insert into public.ai_campaign_dispatch_preflights(
    id,salon_id,manifest_id,release_execution_job_id,preflight_fingerprint,
    status,summary,created_at,valid_until
  ) values(
    '${ids.preflight}','${ids.salon}','${ids.manifest}','${ids.releaseJob}',
    '${preflightFingerprint}','ready',
    jsonb_build_object('preflight_fingerprint','${preflightFingerprint}',
      'dispatch_enabled',false,'no_messages_sent',true,
      'manifest_recipient_count',1,'eligible_count',1,
      'email_recipient_count',1,'sms_recipient_count',0,
      'dual_channel_count',0,'excluded_recent_contact',0,
      'excluded_no_consent',0,'excluded_no_channel',0,
      'excluded_missing_profile',0,
      'excluded_manifest_channel_unavailable',0,
      'estimated_cost_usd_cents',0.1,
      'within_recipient_cap',true,'within_cost_cap',true),
    transaction_timestamp(),transaction_timestamp()+interval '5 minutes'
  );
  insert into public.ai_campaign_dispatch_preflight_decisions(
    preflight_id,salon_id,client_profile_id,sms,email,exclusion
  ) values('${ids.preflight}','${ids.salon}','${ids.profile}',false,true,null);
  insert into public.ai_campaign_dispatch_plans(
    id,salon_id,manifest_id,preflight_id,release_execution_job_id,
    plan_fingerprint,status,recipient_count,sms_recipient_count,
    email_recipient_count,estimated_cost_usd_cents,expires_at,
    dispatch_enabled,no_messages_sent
  ) values(
    '${ids.plan}','${ids.salon}','${ids.manifest}','${ids.preflight}',
    '${ids.releaseJob}',repeat('5',64),'sealed',1,0,1,0.1,
    transaction_timestamp()+interval '5 minutes',false,true
  );
`;

const asServiceRole = (statement) => `
  select pg_catalog.set_config('request.jwt.claim.role','service_role',false);
  ${statement}
`;
const materializeSql = asServiceRole(`
  select public.materialize_reactivation_campaign_deliveries('${ids.plan}')::text;
`);
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function bindBoundMaterial() {
  const output = await sql(asServiceRole(`
    with delivery as (
      select * from public.reactivation_campaign_deliveries
      where dispatch_plan_id='${ids.plan}'
    ), material as (
      select delivery.id,delivery.source_material_fingerprint,
        delivery.contact_fingerprint,delivery.preference_fingerprint,
        delivery.recipient_fingerprint,repeat('6',64) bound_material_fingerprint,
        encode(extensions.digest(convert_to(concat_ws('|',
          'reactivation-payload-v1',delivery.id::text,
          delivery.plan_fingerprint,delivery.preflight_fingerprint,
          delivery.source_material_fingerprint,repeat('6',64),
          delivery.contact_fingerprint,delivery.preference_fingerprint,
          delivery.recipient_fingerprint),'UTF8'),'sha256'),'hex') bound_payload_fingerprint
      from delivery
    )
    select public.bind_reactivation_campaign_delivery_material(
      id,source_material_fingerprint,bound_material_fingerprint,
      contact_fingerprint,preference_fingerprint,recipient_fingerprint,
      bound_payload_fingerprint
    )::text from material;
  `));
  assert.equal(jsonRows(output)[0]?.code, "bound");
}

async function insertOwnerAuthorizationFixture() {
  await sql(`
    with delivery as (
      select *,transaction_timestamp() authorized_at,
        transaction_timestamp()+interval '4 minutes' authorization_expires_at
      from public.reactivation_campaign_deliveries
      where dispatch_plan_id='${ids.plan}'
    ), auth_fixture as (
      select delivery.*,
        encode(extensions.digest(convert_to(concat_ws('|',
          'reactivation-dispatch-authorization-v1',delivery.id::text,
          delivery.salon_id::text,delivery.dispatch_plan_id::text,
          delivery.plan_fingerprint,delivery.source_material_fingerprint,
          delivery.material_fingerprint,delivery.payload_fingerprint,
          delivery.contact_fingerprint,delivery.preference_fingerprint,
          delivery.recipient_fingerprint,delivery.authorized_at::text,
          delivery.authorization_expires_at::text
        ),'UTF8'),'sha256'),'hex') authorization_fingerprint
      from delivery
    )
    insert into public.reactivation_campaign_dispatch_authorizations(
      delivery_id,salon_id,dispatch_plan_id,plan_fingerprint,
      source_material_fingerprint,material_fingerprint,payload_fingerprint,
      contact_fingerprint,preference_fingerprint,recipient_fingerprint,
      authorization_fingerprint,authorized_at,expires_at
    ) select id,salon_id,dispatch_plan_id,plan_fingerprint,
      source_material_fingerprint,material_fingerprint,payload_fingerprint,
      contact_fingerprint,preference_fingerprint,recipient_fingerprint,
      authorization_fingerprint,authorized_at,authorization_expires_at
    from auth_fixture;
  `);
}

try {
  await cleanup();
  await sql(setupSql);

  const materialized = (await Promise.all([
    sql(materializeSql),
    sql(materializeSql),
  ])).flatMap(jsonRows);
  assert.equal(materialized.length, 2);
  assert.deepEqual(
    materialized.map((row) => row.code).sort(),
    ["materialized", "unchanged"],
  );
  assert.equal(
    await sql(`select count(*) from public.reactivation_campaign_deliveries
      where dispatch_plan_id='${ids.plan}'`),
    "1",
  );

  await bindBoundMaterial();

  const unauthorised = (await Promise.all([
    sql(asServiceRole("select claim::text from public.claim_reactivation_campaign_deliveries(1) claim;")),
    sql(asServiceRole("select claim::text from public.claim_reactivation_campaign_deliveries(1) claim;")),
  ])).flatMap(jsonRows);
  const blockedClaims = unauthorised.filter(
    (row) => row.code === "dispatch_not_authorized",
  ).length;
  assert.ok(blockedClaims >= 1 && blockedClaims <= 2);
  assert.equal(unauthorised.some((row) => row.success === true), false);
  assert.equal(
    await sql(`select status from public.reactivation_campaign_deliveries
      where dispatch_plan_id='${ids.plan}'`),
    "awaiting_authorization",
  );

  await insertOwnerAuthorizationFixture();

  const claims = (await Promise.all([
    sql(asServiceRole("select claim::text from public.claim_reactivation_campaign_deliveries(1) claim;")),
    sql(asServiceRole("select claim::text from public.claim_reactivation_campaign_deliveries(1) claim;")),
  ])).flatMap(jsonRows);
  assert.equal(claims.filter((row) => row.code === "delivery_claimed").length, 1);
  const claimed = claims.find((row) => row.code === "delivery_claimed");
  assert.equal(claimed?.provider_ready, false);
  assert.equal(Object.hasOwn(claimed ?? {}, "destination"), false);
  assert.equal(Object.hasOwn(claimed ?? {}, "message"), false);
  assert.equal(
    await sql(`select status||':'||attempt_count from public.reactivation_campaign_deliveries
      where dispatch_plan_id='${ids.plan}'`),
    "leased:1",
  );

  // Fresh fixture for a real FK-child append race. The writer commits an
  // appended manifest recipient/decision while claim waits on the separate
  // parent FOR UPDATE pre-lock. Claim's next statement must use a fresh
  // snapshot, observe aggregate/fingerprint drift and never lease.
  await cleanup();
  await sql(setupSql);
  assert.equal(jsonRows(await sql(materializeSql))[0]?.code, "materialized");
  await bindBoundMaterial();
  await insertOwnerAuthorizationFixture();

  const appendWriter = sql(`
    set application_name='mqa0181_append_writer';
    begin;
    insert into public.ai_campaign_manifest_recipients(
      manifest_id,salon_id,client_profile_id,sms,email
    ) values(
      '${ids.manifest}','${ids.salon}','${ids.appendProfile}',false,true
    );
    insert into public.ai_campaign_dispatch_preflight_decisions(
      preflight_id,salon_id,client_profile_id,sms,email,exclusion
    ) values(
      '${ids.preflight}','${ids.salon}','${ids.appendProfile}',false,true,null
    );
    select pg_sleep(2);
    commit;
  `);
  let writerReady = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await sql(`select count(*) from pg_stat_activity
      where application_name='mqa0181_append_writer'
        and wait_event='PgSleep'`) === "1") {
      writerReady = true;
      break;
    }
    await delay(50);
  }
  assert.equal(writerReady, true);

  const appendClaim = sql(`
    set application_name='mqa0181_append_claim';
    ${asServiceRole(
      "select claim::text from public.claim_reactivation_campaign_deliveries(1) claim;",
    )}
  `);
  let claimWaitedOnParentLock = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await sql(`select count(*) from pg_stat_activity
      where application_name='mqa0181_append_claim'
        and wait_event_type='Lock'`) === "1") {
      claimWaitedOnParentLock = true;
      break;
    }
    await delay(50);
  }
  assert.equal(claimWaitedOnParentLock, true);
  const [, appendClaimOutput] = await Promise.all([appendWriter, appendClaim]);
  const appendClaimRows = jsonRows(appendClaimOutput);
  assert.equal(appendClaimRows.some((row) => row.success === true), false);
  assert.equal(appendClaimRows[0]?.code, "suppressed");
  assert.equal(appendClaimRows[0]?.reason, "source_contract_changed");
  assert.equal(
    await sql(`select status||':'||attempt_count from public.reactivation_campaign_deliveries
      where dispatch_plan_id='${ids.plan}'`),
    "suppressed:0",
  );

  process.stdout.write("PASS reactivation campaign delivery concurrency\n");
} finally {
  await cleanup();
}
