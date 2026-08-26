import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  canonicalLocalApiUrl,
  canonicalLocalDatabaseUrl,
  readLocalStackIdentity,
  runSupabaseStatus,
  sanitizedCommandEnv,
} from "./local-supabase-status.mjs";
import { createLoopbackOnlyFetch } from "./local-only-fetch.mjs";

if (process.env.NAILIQ_ALLOW_DISPOSABLE_LOCAL_DB !== "1") {
  throw new Error("Set NAILIQ_ALLOW_DISPOSABLE_LOCAL_DB=1 for this disposable-local rehearsal");
}

const stack = readLocalStackIdentity(process.cwd(), "MQA-0123 local stack");
if (stack.projectId !== "nailiq-e2e-local") {
  throw new Error("MQA-0123 rehearsal requires project_id nailiq-e2e-local");
}
const status = runSupabaseStatus(stack);
const apiOrigin = canonicalLocalApiUrl(status.apiUrl, "MQA-0123 API URL");
canonicalLocalDatabaseUrl(status.dbUrl, "MQA-0123 DB URL");

let loopbackFetches = 0;
const localOnlyFetch = createLoopbackOnlyFetch(apiOrigin, {
  onAllowed: () => { loopbackFetches += 1; },
});

const clientOptions = {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { fetch: localOnlyFetch },
};
const service = createClient(status.apiUrl, status.serviceRoleKey, clientOptions);
const anon = createClient(status.apiUrl, status.anonKey, clientOptions);

const runTag = randomUUID().replaceAll("-", "").slice(0, 12);
const numberTag = String(randomInt(1000, 9999));
const salons = {
  accountA: randomUUID(),
  accountB: randomUUID(),
  sameAccountOtherSalon: randomUUID(),
  disabled: randomUUID(),
};
const salonIds = Object.values(salons);
const phones = {
  existing: `1999${numberTag}001`,
  dedup: `1999${numberTag}002`,
  concurrent: `1999${numberTag}003`,
  collisionA: `1999${numberTag}004`,
  collisionB: `1999${numberTag}005`,
};
const allPhones = Object.values(phones);
const preexistingProfileId = randomUUID();
const consentAt = "2026-01-02T03:04:05.000Z";
const emailConsentAt = "2026-02-03T04:05:06.000Z";
const legacySquareId = `legacy-${runTag}`;

for (const value of [...salonIds, preexistingProfileId]) {
  assert.match(value, /^[0-9a-f-]{36}$/u);
}
for (const phone of allPhones) assert.match(phone, /^[0-9]{8,15}$/u);

function cleanupSql() {
  const quotedSalons = salonIds.map((id) => `'${id}'::uuid`).join(",");
  const quotedPhones = allPhones.map((phone) => `'${phone}'`).join(",");
  return `
    BEGIN;
    DELETE FROM public.square_customer_identities
    WHERE first_seen_salon_id IN (${quotedSalons})
       OR client_profile_id IN (
         SELECT id FROM public.client_profiles WHERE phone IN (${quotedPhones})
       );
    DELETE FROM public.salon_clients WHERE salon_id IN (${quotedSalons});
    DELETE FROM public.salons WHERE id IN (${quotedSalons});
    DELETE FROM public.client_profiles WHERE phone IN (${quotedPhones});
    COMMIT;
  `;
}

async function cleanup() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = spawnSync("psql", [status.dbUrl, "-v", "ON_ERROR_STOP=1", "-c", cleanupSql()], {
      cwd: stack.stackDir,
      encoding: "utf8",
      env: sanitizedCommandEnv(process.env),
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
    if (!result.error && result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  throw new Error("MQA-0123 local fixture cleanup failed");
}

function assertOk(result, label) {
  if (result.error) throw new Error(`${label} failed`);
  return result.data;
}

async function retryTransientSchemaCache(operation) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await operation();
    if (result.error?.code !== "PGRST002") return result;
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  return operation();
}

const contexts = {
  accountA: { environment: "sandbox", merchant: `merchant-a-${runTag}`, location: `location-a-${runTag}` },
  accountB: { environment: "sandbox", merchant: `merchant-b-${runTag}`, location: `location-b-${runTag}` },
  sameAccountOtherSalon: { environment: "sandbox", merchant: `merchant-a-${runTag}`, location: `location-c-${runTag}` },
  disabled: { environment: "sandbox", merchant: `merchant-d-${runTag}`, location: `location-d-${runTag}` },
};

const fakeCustomers = new Map();
let fakeSquareReads = 0;
function fakeSquareGetCustomer(customerId) {
  fakeSquareReads += 1;
  const customer = fakeCustomers.get(customerId);
  if (!customer) throw new Error("fake Square customer missing");
  return structuredClone(customer);
}

function rpcArgs(salonId, context, customerId, customer = null) {
  return {
    p_salon_id: salonId,
    p_provider_environment: context.environment,
    p_provider_merchant_id: context.merchant,
    p_provider_location_id: context.location,
    p_square_customer_id: customerId,
    p_phone: customer?.phone_number ?? null,
    p_name: customer
      ? `${customer.given_name ?? ""} ${customer.family_name ?? ""}`.trim() || null
      : null,
    p_email: customer?.email_address?.trim().toLowerCase() || null,
  };
}

async function resolveFakeSquareCustomer(salonId, context, customerId) {
  const lookup = await service.rpc(
    "resolve_square_customer_identity",
    rpcArgs(salonId, context, customerId),
  );
  if (lookup.error) throw new Error("local identity lookup failed");
  if (lookup.data?.code !== "not_found") return lookup.data;

  const fakeCustomer = fakeSquareGetCustomer(customerId);
  const resolved = await service.rpc(
    "resolve_square_customer_identity",
    rpcArgs(salonId, context, customerId, fakeCustomer),
  );
  if (resolved.error) throw new Error("local identity resolve failed");
  return resolved.data;
}

let rehearsalError;
try {
  const salonRows = [
    [salons.accountA, "accountA"],
    [salons.accountB, "accountB"],
    [salons.sameAccountOtherSalon, "sameAccountOtherSalon"],
    [salons.disabled, "disabled"],
  ].map(([id], index) => ({
    id,
    slug: `mqa-0123-${runTag}-${index}`,
    name: `MQA-0123 Local ${index}`,
    phone: `19995550${String(index).padStart(3, "0")}`,
    payment_provider: "square",
    reminders_enabled: false,
    sms_reminders_enabled: false,
    sms_outbound_enabled: false,
    email_outbound_enabled: false,
    voice_ai_enabled: false,
  }));
  assertOk(await service.from("salons").insert(salonRows), "salon fixture insert");

  const integrationRows = Object.entries(salons).map(([key, salonId]) => {
    const context = contexts[key];
    return {
      salon_id: salonId,
      merchant_id: context.merchant,
      location_id: context.location,
      access_token: "fake-local-token-never-sent",
      application_id: "fake-local-app",
      environment: context.environment,
      enabled: true,
      sync_pull_create: key !== "disabled",
      sync_pull_update: false,
      sync_pull_cancel: false,
      sync_push_create: false,
      sync_push_update: false,
      sync_push_cancel: false,
    };
  });
  assertOk(
    await service.from("square_integrations").insert(integrationRows),
    "integration fixture insert",
  );
  assertOk(await service.from("client_profiles").insert({
    id: preexistingProfileId,
    phone: phones.existing,
    name: "Existing Name Must Win",
    email: "existing@example.test",
    square_customer_id: legacySquareId,
    marketing_consent_at: consentAt,
    marketing_email_consent_at: emailConsentAt,
  }), "preexisting profile insert");

  const ids = {
    existing: `customer-existing-${runTag}`,
    dedupA: `customer-dedup-a-${runTag}`,
    dedupB: `customer-dedup-b-${runTag}`,
    concurrent: `customer-concurrent-${runTag}`,
    collision: `customer-collision-${runTag}`,
  };
  fakeCustomers.set(ids.existing, {
    id: ids.existing,
    given_name: "Provider Name Must Not Overwrite",
    family_name: "Existing",
    phone_number: phones.existing,
    email_address: "provider-overwrite@example.test",
  });
  fakeCustomers.set(ids.dedupA, { id: ids.dedupA, given_name: "Dedup", family_name: "One", phone_number: phones.dedup });
  fakeCustomers.set(ids.dedupB, { id: ids.dedupB, given_name: "Dedup", family_name: "Two", phone_number: phones.dedup });
  fakeCustomers.set(ids.concurrent, { id: ids.concurrent, given_name: "Concurrent", family_name: "Client", phone_number: phones.concurrent });

  const existing = await resolveFakeSquareCustomer(
    salons.accountA,
    contexts.accountA,
    ids.existing,
  );
  assert.equal(existing.client_profile_id, preexistingProfileId);
  assert.equal(existing.code, "linked_profile");
  assert.equal(existing.created_profile, false);

  const replay = await resolveFakeSquareCustomer(
    salons.accountA,
    contexts.accountA,
    ids.existing,
  );
  assert.equal(replay.client_profile_id, preexistingProfileId);
  assert.equal(replay.code, "replayed");

  const dedupResults = await Promise.all([
    resolveFakeSquareCustomer(salons.accountA, contexts.accountA, ids.dedupA),
    resolveFakeSquareCustomer(salons.accountA, contexts.accountA, ids.dedupB),
  ]);
  assert.equal(new Set(dedupResults.map((row) => row.client_profile_id)).size, 1);
  assert.equal(dedupResults.filter((row) => row.created_profile).length, 1);

  const concurrentResults = await Promise.all(Array.from({ length: 12 }, () => (
    resolveFakeSquareCustomer(salons.accountA, contexts.accountA, ids.concurrent)
  )));
  assert.equal(new Set(concurrentResults.map((row) => row.client_profile_id)).size, 1);
  assert.equal(concurrentResults.filter((row) => row.created_profile).length, 1);

  fakeCustomers.set(ids.collision, { id: ids.collision, given_name: "Account", family_name: "A", phone_number: phones.collisionA });
  const collisionA = await resolveFakeSquareCustomer(
    salons.accountA,
    contexts.accountA,
    ids.collision,
  );
  fakeCustomers.set(ids.collision, { id: ids.collision, given_name: "Account", family_name: "B", phone_number: phones.collisionB });
  const collisionB = await resolveFakeSquareCustomer(
    salons.accountB,
    contexts.accountB,
    ids.collision,
  );
  assert.notEqual(collisionA.client_profile_id, collisionB.client_profile_id);

  const sameAccountOtherSalon = await resolveFakeSquareCustomer(
    salons.sameAccountOtherSalon,
    contexts.sameAccountOtherSalon,
    ids.collision,
  );
  assert.equal(sameAccountOtherSalon.client_profile_id, collisionA.client_profile_id);
  assert.equal(sameAccountOtherSalon.code, "linked_salon");

  const mismatch = await service.rpc(
    "resolve_square_customer_identity",
    rpcArgs(salons.accountA, contexts.accountB, ids.collision),
  );
  assert.ok(mismatch.error?.message.includes("square_customer_identity_context_mismatch"));
  const disabled = await service.rpc(
    "resolve_square_customer_identity",
    rpcArgs(salons.disabled, contexts.disabled, `customer-disabled-${runTag}`),
  );
  assert.ok(disabled.error?.message.includes("square_customer_identity_context_mismatch"));

  const anonRpc = await anon.rpc(
    "resolve_square_customer_identity",
    rpcArgs(salons.accountA, contexts.accountA, ids.existing),
  );
  assert.ok(anonRpc.error);
  const anonTable = await anon.from("square_customer_identities").select("id").limit(1);
  assert.ok(anonTable.error);

  const { data: unchangedProfile, error: unchangedError } = await retryTransientSchemaCache(
    () => service
      .from("client_profiles")
      .select("name,email,square_customer_id,marketing_consent_at,marketing_email_consent_at")
      .eq("id", preexistingProfileId),
  );
  if (unchangedError) {
    throw new Error(
      `consent invariance lookup failed:${unchangedError.code ?? "unknown"}:${unchangedError.message}`,
    );
  }
  assert.equal(unchangedProfile.length, 1);
  assert.equal(unchangedProfile[0].name, "Existing Name Must Win");
  assert.equal(unchangedProfile[0].email, "existing@example.test");
  assert.equal(unchangedProfile[0].square_customer_id, legacySquareId);
  assert.equal(Date.parse(unchangedProfile[0].marketing_consent_at), Date.parse(consentAt));
  assert.equal(
    Date.parse(unchangedProfile[0].marketing_email_consent_at),
    Date.parse(emailConsentAt),
  );

  const { data: newProfiles, error: newProfilesError } = await retryTransientSchemaCache(
    () => service
      .from("client_profiles")
      .select("id,phone,square_customer_id,marketing_consent_at,marketing_email_consent_at")
      .in("phone", allPhones),
  );
  if (newProfilesError) throw new Error("profile matrix lookup failed");
  assert.equal(newProfiles.length, 5);
  for (const profile of newProfiles) {
    if (profile.id === preexistingProfileId) continue;
    assert.equal(profile.square_customer_id, null);
    assert.equal(profile.marketing_consent_at, null);
    assert.equal(profile.marketing_email_consent_at, null);
  }

  const { data: collisionMappings, error: collisionMappingsError } = await retryTransientSchemaCache(
    () => service
      .from("square_customer_identities")
      .select("provider_merchant_id,client_profile_id")
      .eq("provider_environment", "sandbox")
      .eq("square_customer_id", ids.collision),
  );
  if (collisionMappingsError) throw new Error("collision mapping lookup failed");
  assert.equal(collisionMappings.length, 2);
  assert.equal(new Set(collisionMappings.map((row) => row.provider_merchant_id)).size, 2);
  assert.equal(new Set(collisionMappings.map((row) => row.client_profile_id)).size, 2);

  const { data: salonLinks, error: salonLinksError } = await retryTransientSchemaCache(
    () => service
      .from("salon_clients")
      .select("salon_id,client_profile_id")
      .in("salon_id", salonIds),
  );
  if (salonLinksError) throw new Error("salon link lookup failed");
  assert.equal(salonLinks.length, 6);

  const { data: outboundState, error: outboundStateError } = await retryTransientSchemaCache(
    () => service
      .from("salons")
      .select("sms_outbound_enabled,email_outbound_enabled,reminders_enabled,sms_reminders_enabled,voice_ai_enabled")
      .in("id", salonIds),
  );
  if (outboundStateError) throw new Error("outbound state lookup failed");
  assert.equal(outboundState.length, 4);
  for (const row of outboundState) {
    assert.equal(row.sms_outbound_enabled, false);
    assert.equal(row.email_outbound_enabled, false);
    assert.equal(row.reminders_enabled, false);
    assert.equal(row.sms_reminders_enabled, false);
    assert.equal(row.voice_ai_enabled, false);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId: stack.projectId,
    apiOrigin,
    fakeSquareReads,
    exactReplay: true,
    phoneDedup: true,
    concurrentCalls: concurrentResults.length,
    crossAccountCollisionIsolated: true,
    sameAccountSalonLinkExplicit: true,
    consentInvariant: true,
    legacyColumnUnchanged: true,
    anonDenied: true,
    outboundHardOff: true,
    loopbackFetches,
  })}\n`);
} catch (error) {
  rehearsalError = error;
} finally {
  try {
    await cleanup();
  } catch (cleanupError) {
    rehearsalError = rehearsalError
      ? new AggregateError(
        [rehearsalError, cleanupError],
        "MQA-0123 rehearsal and fixture cleanup both failed",
      )
      : cleanupError;
  }
}

if (rehearsalError) throw rehearsalError;
