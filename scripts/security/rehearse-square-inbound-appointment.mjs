import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import {
  canonicalLocalApiUrl,
  canonicalLocalDatabaseUrl,
  readLocalStackIdentity,
  runSupabaseStatus,
  sanitizedCommandEnv,
} from "./local-supabase-status.mjs";

const REQUIRED_APPROVAL = "RUN_LOCAL_SUPABASE_WITH_FAKE_SQUARE_ONLY";
const EXPECTED_PROJECT_ID = "nailiq-e2e-local";
const FAKE_SQUARE_ORIGIN = "https://connect.squareupsandbox.com";

if (process.env.NAILIQ_SQUARE_INBOUND_LOCAL_APPROVAL !== REQUIRED_APPROVAL) {
  throw new Error(
    `Set NAILIQ_SQUARE_INBOUND_LOCAL_APPROVAL=${REQUIRED_APPROVAL} for this disposable-local rehearsal`,
  );
}
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("MQA-0060 rehearsal refuses a production runtime");
}

const stack = readLocalStackIdentity(process.cwd(), "MQA-0060 local stack");
if (stack.projectId !== EXPECTED_PROJECT_ID) {
  throw new Error(`MQA-0060 rehearsal requires project_id ${EXPECTED_PROJECT_ID}`);
}
const status = runSupabaseStatus(stack);
const apiOrigin = canonicalLocalApiUrl(status.apiUrl, "MQA-0060 API URL");
canonicalLocalDatabaseUrl(status.dbUrl, "MQA-0060 DB URL");

process.env.SUPABASE_INTERNAL_URL = status.apiUrl;
process.env.NEXT_PUBLIC_SUPABASE_URL = status.apiUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.serviceRoleKey;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = status.anonKey;
process.env.DISABLE_OUTBOUND_SMS = "1";
process.env.DISABLE_OUTBOUND_CALLS = "1";
process.env.DISABLE_OUTBOUND_EMAIL = "1";
process.env.CRON_SECRET = `mqa-0060-local-${randomUUID()}`;

const originalFetch = globalThis.fetch;
let loopbackFetches = 0;
const fakeSquareCalls = [];

const tag = randomUUID().replaceAll("-", "").slice(0, 12);
const salonIds = {
  subject: randomUUID(),
  otherTenant: randomUUID(),
};
const serviceIds = {
  subject: randomUUID(),
  otherTenant: randomUUID(),
};
const staffIds = {
  subject: randomUUID(),
  otherTenant: randomUUID(),
};
const provider = {
  subjectMerchant: `mqa-merchant-a-${tag}`,
  otherMerchant: `mqa-merchant-b-${tag}`,
  subjectLocation: `mqa-location-a-${tag}`,
  otherLocation: `mqa-location-b-${tag}`,
  subjectToken: `fake-local-token-a-${tag}`,
  otherToken: `fake-local-token-b-${tag}`,
  teamMember: `mqa-team-member-${tag}`,
  variation: `mqa-variation-${tag}`,
  validBooking: `mqa-booking-valid-${tag}`,
  wrongLocationBooking: `mqa-booking-wrong-location-${tag}`,
};
const startedAt = new Date().toISOString();
const appointmentStart = new Date(Date.now() - 15 * 60_000);
appointmentStart.setMilliseconds(0);

function inputUrl(input) {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return String(input);
}

function requestHeaders(input, init) {
  if (init?.headers) return new Headers(init.headers);
  return input instanceof Request ? input.headers : new Headers();
}

function jsonResponse(body, statusCode = 200) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}

function fakeProviderBookings(target) {
  assert.equal(target.searchParams.get("location_id"), provider.subjectLocation);
  const begin = Date.parse(target.searchParams.get("start_at_min") ?? "");
  const end = Date.parse(target.searchParams.get("start_at_max") ?? "");
  assert.ok(Number.isFinite(begin) && Number.isFinite(end) && begin < end);
  if (!(begin <= appointmentStart.getTime() && appointmentStart.getTime() < end)) {
    return [];
  }
  const segment = {
    duration_minutes: 30,
    service_variation_id: provider.variation,
    service_variation_version: 7,
    team_member_id: provider.teamMember,
  };
  return [
    {
      id: provider.validBooking,
      version: 1,
      status: "ACCEPTED",
      location_id: provider.subjectLocation,
      start_at: appointmentStart.toISOString(),
      updated_at: appointmentStart.toISOString(),
      appointment_segments: [segment],
    },
    {
      id: provider.wrongLocationBooking,
      version: 1,
      status: "ACCEPTED",
      location_id: provider.otherLocation,
      start_at: appointmentStart.toISOString(),
      updated_at: appointmentStart.toISOString(),
      appointment_segments: [segment],
    },
  ];
}

globalThis.fetch = async (input, init) => {
  const target = new URL(inputUrl(input));
  if (target.origin === apiOrigin) {
    loopbackFetches += 1;
    return originalFetch(input, { ...init, redirect: "error" });
  }
  if (target.origin !== FAKE_SQUARE_ORIGIN) {
    throw new Error(`MQA-0060 blocked non-local/non-fake origin ${target.origin}`);
  }

  const headers = requestHeaders(input, init);
  assert.equal(headers.get("authorization"), `Bearer ${provider.subjectToken}`);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  fakeSquareCalls.push({ method, path: target.pathname });

  if (method === "GET" && target.pathname === "/v2/bookings") {
    return jsonResponse({ bookings: fakeProviderBookings(target) });
  }
  if (method === "POST" && target.pathname === "/v2/catalog/search") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.deepEqual(body.object_types, ["ITEM"]);
    return jsonResponse({
      objects: [{
        id: `mqa-catalog-item-${tag}`,
        type: "ITEM",
        item_data: {
          name: "MQA Local Manicure",
          variations: [{
            id: provider.variation,
            version: 7,
            type: "ITEM_VARIATION",
            item_variation_data: {
              name: "Regular",
              price_money: { amount: 4_000, currency: "CAD" },
            },
          }],
        },
      }],
    });
  }
  if (method === "GET" && target.pathname === "/v2/payments") {
    assert.equal(target.searchParams.get("location_id"), provider.subjectLocation);
    return jsonResponse({ payments: [] });
  }
  throw new Error(`MQA-0060 blocked unexpected fake Square call ${method} ${target.pathname}`);
};

const service = createClient(status.apiUrl, status.serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
  global: { fetch: globalThis.fetch },
});

function requireData(result, label) {
  if (result.error) throw new Error(`${label} failed: ${result.error.code ?? "database_error"}`);
  return result.data;
}

async function countRows(table, column, values) {
  const result = await service
    .from(table)
    .select("*", { count: "exact", head: true })
    .in(column, values);
  if (result.error) throw new Error(`${table} count failed`);
  return result.count ?? 0;
}

const baselineWorkerState = requireData(
  await service
    .from("ai_execution_worker_state")
    .select("*")
    .eq("worker_name", "square_sync")
    .maybeSingle(),
  "worker-state baseline read",
);
const createdCronRunIds = new Set();
let workerStateMutated = false;

let primaryError;
let cleanupError;
let evidence;

async function cleanup() {
  const cleanupFailures = [];
  const attempt = async (label, operation) => {
    try {
      const result = await operation();
      if (result.error) cleanupFailures.push(`${label}:${result.error.code ?? "database_error"}`);
    } catch {
      cleanupFailures.push(`${label}:exception`);
    }
  };

  await attempt("system-audit-existing", () => service.from("system_audit").delete().in("salon_id", Object.values(salonIds)));
  await attempt("bookings", () => service.from("bookings").delete().in("salon_id", Object.values(salonIds)));
  await attempt("integrations", () => service.from("square_integrations").delete().in("salon_id", Object.values(salonIds)));
  await attempt("staff", () => service.from("staff").delete().in("salon_id", Object.values(salonIds)));
  await attempt("services", () => service.from("services").delete().in("salon_id", Object.values(salonIds)));
  await attempt("salons", () => service.from("salons").delete().in("id", Object.values(salonIds)));
  // The fixture control-plane deletes create their own audit rows. Remove that
  // final local-only trail only after every fixture salon row is gone.
  await attempt("system-audit-final", () => service.from("system_audit").delete().in("salon_id", Object.values(salonIds)));
  if (workerStateMutated) {
    await attempt("worker-state-current", async () => {
      const current = await service
        .from("ai_execution_worker_state")
        .select("run_id")
        .eq("worker_name", "square_sync")
        .maybeSingle();
      const runId = current.data?.run_id;
      if (typeof runId === "string") createdCronRunIds.add(runId);
      return { data: null, error: current.error };
    });

    const runIds = [...createdCronRunIds];
    if (runIds.some((runId) => !/^[0-9a-f-]{36}$/u.test(runId))) {
      cleanupFailures.push("worker-runs:invalid-id");
    } else if (runIds.length > 0) {
      const quotedRunIds = runIds.map((runId) => `'${runId}'::uuid`).join(",");
      const result = spawnSync(
        process.env.PSQL_BIN?.trim() || "psql",
        [
          status.dbUrl,
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `BEGIN;
DELETE FROM public.ai_execution_worker_state
WHERE worker_name = 'square_sync' AND run_id IN (${quotedRunIds});
DELETE FROM public.ai_worker_runs
WHERE worker_name = 'square_sync' AND run_id IN (${quotedRunIds});
COMMIT;`,
        ],
        {
          cwd: stack.stackDir,
          encoding: "utf8",
          env: sanitizedCommandEnv(process.env),
          maxBuffer: 1024 * 1024,
          timeout: 20_000,
        },
      );
      if (result.error || result.status !== 0) {
        cleanupFailures.push("worker-runs:postgres-cleanup-failed");
      }
    }

    if (baselineWorkerState) {
      await attempt("worker-state-restore", () => service
        .from("ai_execution_worker_state")
        .upsert(baselineWorkerState, { onConflict: "worker_name" }));
    }

    try {
      if (createdCronRunIds.size > 0) {
        const runCount = await countRows(
          "ai_worker_runs",
          "run_id",
          [...createdCronRunIds],
        );
        if (runCount !== 0) cleanupFailures.push(`ai_worker_runs:residue:${runCount}`);
      }
      const restoredState = await service
        .from("ai_execution_worker_state")
        .select("*")
        .eq("worker_name", "square_sync")
        .maybeSingle();
      if (restoredState.error) {
        cleanupFailures.push("worker-state:residue-check-failed");
      } else if (baselineWorkerState) {
        try {
          assert.deepEqual(restoredState.data, baselineWorkerState);
        } catch {
          cleanupFailures.push("worker-state:baseline-not-restored");
        }
      } else if (restoredState.data !== null) {
        cleanupFailures.push("worker-state:residue");
      }
    } catch {
      cleanupFailures.push("worker-heartbeat:residue-check-failed");
    }
  }

  for (const [table, column] of [
    ["bookings", "salon_id"],
    ["square_integrations", "salon_id"],
    ["staff", "salon_id"],
    ["services", "salon_id"],
    ["salons", "id"],
    ["system_audit", "salon_id"],
  ]) {
    try {
      const count = await countRows(table, column, Object.values(salonIds));
      if (count !== 0) cleanupFailures.push(`${table}:residue:${count}`);
    } catch {
      cleanupFailures.push(`${table}:residue-check-failed`);
    }
  }

  if (cleanupFailures.length > 0) {
    throw new Error(`MQA-0060 cleanup failed: ${cleanupFailures.join(",")}`);
  }
}

try {
  const existingEligible = requireData(
    await service
      .from("square_integrations")
      .select("salon_id")
      .eq("enabled", true)
      .not("access_token", "is", null),
    "eligible integration preflight",
  );
  if ((existingEligible ?? []).length !== 0) {
    throw new Error("MQA-0060 requires a local stack with no pre-existing cron-eligible Square integration");
  }

  requireData(await service.from("salons").insert([
    {
      id: salonIds.subject,
      slug: `mqa-0060-a-${tag}`,
      name: "MQA-0060 Local Subject",
      phone: "+16045550101",
      currency_code: "CAD",
      resources_enabled: false,
      reminders_enabled: false,
      sms_reminders_enabled: false,
      sms_outbound_enabled: false,
      email_outbound_enabled: false,
      voice_ai_enabled: false,
      payment_provider: "square",
    },
    {
      id: salonIds.otherTenant,
      slug: `mqa-0060-b-${tag}`,
      name: "MQA-0060 Other Tenant",
      phone: "+16045550102",
      currency_code: "CAD",
      resources_enabled: false,
      reminders_enabled: false,
      sms_reminders_enabled: false,
      sms_outbound_enabled: false,
      email_outbound_enabled: false,
      voice_ai_enabled: false,
      payment_provider: "square",
    },
  ]), "salon fixture insert");

  requireData(await service.from("services").insert([
    {
      id: serviceIds.subject,
      salon_id: salonIds.subject,
      name: "MQA Local Manicure",
      price_cents: 4_000,
      duration_minutes: 30,
    },
    {
      id: serviceIds.otherTenant,
      salon_id: salonIds.otherTenant,
      name: "MQA Local Manicure",
      price_cents: 9_999,
      duration_minutes: 90,
    },
  ]), "service fixture insert");

  requireData(await service.from("staff").insert([
    {
      id: staffIds.subject,
      salon_id: salonIds.subject,
      name: "MQA Local Staff A",
      status: "active",
      square_team_member_id: provider.teamMember,
    },
    {
      id: staffIds.otherTenant,
      salon_id: salonIds.otherTenant,
      name: "MQA Local Staff B",
      status: "active",
      square_team_member_id: provider.teamMember,
    },
  ]), "staff fixture insert");

  requireData(await service.from("square_integrations").insert([
    {
      salon_id: salonIds.subject,
      merchant_id: provider.subjectMerchant,
      location_id: provider.subjectLocation,
      access_token: provider.subjectToken,
      application_id: `fake-local-app-${tag}`,
      environment: "sandbox",
      enabled: true,
      sync_pull_create: true,
      sync_pull_update: true,
      sync_pull_cancel: true,
      sync_push_create: false,
      sync_push_update: false,
      sync_push_cancel: false,
    },
    {
      salon_id: salonIds.otherTenant,
      merchant_id: provider.otherMerchant,
      location_id: provider.otherLocation,
      access_token: provider.otherToken,
      application_id: `fake-local-app-other-${tag}`,
      environment: "sandbox",
      enabled: false,
      sync_pull_create: true,
      sync_pull_update: true,
      sync_pull_cancel: true,
      sync_push_create: false,
      sync_push_update: false,
      sync_push_cancel: false,
    },
  ]), "integration fixture insert");

  const { runSquareForwardSync } = await import("../../src/shared/integrations/square/sync.ts");
  const concurrent = await Promise.all([
    runSquareForwardSync(salonIds.subject),
    runSquareForwardSync(salonIds.subject),
  ]);
  assert.equal(concurrent.reduce((sum, row) => sum + row.inserted, 0), 1);

  const imported = requireData(
    await service
      .from("bookings")
      .select("id, salon_id, service_id, staff_id, client_name, booking_channel, source, square_booking_id, start_time_utc, end_time_utc, status")
      .eq("salon_id", salonIds.subject)
      .eq("square_booking_id", provider.validBooking),
    "import readback",
  );
  assert.equal(imported.length, 1);
  assert.equal(imported[0].service_id, serviceIds.subject);
  assert.equal(imported[0].staff_id, staffIds.subject);
  assert.equal(imported[0].booking_channel, "square");
  assert.equal(imported[0].source, "appointment");
  assert.equal(imported[0].status, "confirmed");
  assert.equal(Date.parse(imported[0].end_time_utc) - Date.parse(imported[0].start_time_utc), 30 * 60_000);

  assert.equal(
    await countRows("bookings", "square_booking_id", [provider.wrongLocationBooking]),
    0,
  );
  assert.equal(await countRows("bookings", "salon_id", [salonIds.otherTenant]), 0);

  const replay = await runSquareForwardSync(salonIds.subject);
  assert.equal(replay.inserted, 0);
  assert.equal(
    await countRows("bookings", "square_booking_id", [provider.validBooking]),
    1,
  );

  const { GET } = await import("../../src/app/api/cron/square-sync/route.ts");
  const cronRequest = () => new Request("http://127.0.0.1/api/cron/square-sync", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const successResponse = await GET(cronRequest());
  workerStateMutated = true;
  const successBody = await successResponse.json();
  const successfulWorkerState = requireData(
    await service
      .from("ai_execution_worker_state")
      .select("run_id")
      .eq("worker_name", "square_sync")
      .single(),
    "successful cron worker-state readback",
  );
  assert.match(successfulWorkerState.run_id, /^[0-9a-f-]{36}$/u);
  createdCronRunIds.add(successfulWorkerState.run_id);
  assert.equal(successResponse.status, 200);
  assert.equal(successBody.ok, true);
  assert.equal(successBody.results[salonIds.subject].inserted, 0);
  assert.equal(successBody.results[salonIds.otherTenant], undefined);

  requireData(
    await service.from("salons").update({ currency_code: null }).eq("id", salonIds.subject),
    "missing-currency setup",
  );
  const providerCallsBeforeFailure = fakeSquareCalls.length;
  const failureResponse = await GET(cronRequest());
  workerStateMutated = true;
  const failureBody = await failureResponse.json();
  const failedWorkerState = requireData(
    await service
      .from("ai_execution_worker_state")
      .select("run_id")
      .eq("worker_name", "square_sync")
      .single(),
    "failed cron worker-state readback",
  );
  assert.match(failedWorkerState.run_id, /^[0-9a-f-]{36}$/u);
  createdCronRunIds.add(failedWorkerState.run_id);
  assert.equal(failureResponse.status, 500);
  assert.equal(failureBody.ok, false);
  assert.equal(failureBody.results[salonIds.subject].error, "square_salon_currency_invalid");
  assert.equal(fakeSquareCalls.length, providerCallsBeforeFailure);

  const unhealthy = requireData(
    await service
      .from("square_integrations")
      .select("last_error, last_run_at")
      .eq("salon_id", salonIds.subject)
      .single(),
    "failed health readback",
  );
  assert.equal(unhealthy.last_error, "square_salon_currency_invalid");
  assert.ok(Date.parse(unhealthy.last_run_at) >= Date.parse(startedAt));

  requireData(
    await service.from("salons").update({ currency_code: "CAD" }).eq("id", salonIds.subject),
    "currency restore",
  );
  const recovered = await runSquareForwardSync(salonIds.subject);
  assert.equal(recovered.inserted, 0);
  const healthy = requireData(
    await service
      .from("square_integrations")
      .select("last_error, last_run_at, cursor_synced_at")
      .eq("salon_id", salonIds.subject)
      .single(),
    "recovered health readback",
  );
  assert.equal(healthy.last_error, null);
  assert.ok(Date.parse(healthy.last_run_at) >= Date.parse(startedAt));
  assert.ok(Date.parse(healthy.cursor_synced_at) >= Date.parse(startedAt));

  evidence = {
    id: "MQA-0060",
    outcome: "PASS_LOCAL_ACTUAL_POSTGRES_FAKE_SQUARE_RUNTIME",
    project_id: stack.projectId,
    api_origin: apiOrigin,
    exact_runtime: "runSquareForwardSync",
    exact_cron_route: "/api/cron/square-sync",
    concurrent_runs: concurrent.length,
    imported_rows: imported.length,
    replay_rows: await countRows("bookings", "square_booking_id", [provider.validBooking]),
    wrong_location_rows: await countRows("bookings", "square_booking_id", [provider.wrongLocationBooking]),
    other_tenant_rows: await countRows("bookings", "salon_id", [salonIds.otherTenant]),
    cron_success_status: successResponse.status,
    cron_failure_status: failureResponse.status,
    persisted_failure_code: unhealthy.last_error,
    recovered_health_error: healthy.last_error,
    fake_square_calls: fakeSquareCalls.length,
    loopback_fetches: loopbackFetches,
    outbound_provider_call: false,
    remote_database_touched: false,
    production_or_live_salon_touched: false,
  };
} catch (error) {
  primaryError = error;
} finally {
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  globalThis.fetch = originalFetch;
}

if (primaryError) {
  if (cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "MQA-0060 rehearsal and cleanup failed");
  }
  throw primaryError;
}
if (cleanupError) throw cleanupError;

assert.ok(evidence);
evidence.cleanup = "PASS_NO_FIXTURE_RESIDUE";
console.log(JSON.stringify(evidence, null, 2));
