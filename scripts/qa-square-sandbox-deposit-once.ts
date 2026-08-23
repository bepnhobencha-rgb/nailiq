/**
 * MQA-0196 one-shot Square Sandbox public-deposit certification harness.
 *
 * This script is deliberately inert unless every non-production safeguard is
 * explicitly present. It drives the real app HTTP boundaries (quote -> Square
 * stage 1 -> deliberately lost Square stage-2 response -> cron readback ->
 * paid booking create), proves exact replay and durable receipts in the pinned
 * non-production database, then removes the synthetic database fixture.
 * Square's fixed sandbox nonce is the only card source it can submit; there is
 * no CLI or environment override for amount or source token.
 *
 * Do not wrap this in an automatic retry. Once stage 2 begins, a lost response
 * can hide a provider acceptance. The harness preserves the database ledger in
 * that case and reports RECONCILIATION_REQUIRED.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const QA_SQUARE_SANDBOX_DEPOSIT = {
  amountCents: 100,
  currency: "CAD",
  sourceToken: "cnon:card-nonce-ok",
  salonId: "019c0000-0000-7000-8000-000000000196",
  serviceId: "019c0000-0000-7000-8000-000000000197",
  staffId: "019c0000-0000-7000-8000-000000000198",
  bookingRequestId: "019c0000-0000-7000-8000-000000000199",
  paymentRequestId: "019c0000-0000-7000-8000-00000000019a",
  slug: "e2e-square-sandbox-deposit-once",
  clientPhone: "16045550196",
  clientName: "E2E Square Sandbox",
  staffName: "QA Sandbox Tech",
} as const;

const PRODUCTION_SUPABASE_REF = "fshmobzyjhmtvndobwsy";
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const LOCAL_POSTGRES_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const QA_SQUARE_SANDBOX_MARKER =
  "/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/mqa-0196-square-sandbox-one-shot.json";
const HASH_RE = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_REF_RE = /^[a-z0-9]{20}$/;
const SANDBOX_APPLICATION_RE = /^sandbox-sq0idb-[A-Za-z0-9_-]{8,}$/;
const SQUARE_MERCHANT_RE = /^ML[A-Z0-9]{8,}$/;
const SQUARE_LOCATION_RE = /^L[A-Z0-9]{8,}$/;
const SQUARE_SANDBOX_TOKEN_RE = /^EAAA[A-Za-z0-9_-]{20,}$/;
const SQUARE_SANDBOX_TOKEN_STATUS =
  "https://connect.squareupsandbox.com/oauth2/token/status";
const SQUARE_VERSION = "2024-12-18";
const REQUEST_TIMEOUT_MS = 30_000;
const RECONCILIATION_WAIT_MS = 45_000;
const QA_RESPONSE_LOSS_HEADER = "x-nailiq-qa-square-response-loss";
const execFileAsync = promisify(execFile);

type Env = Record<string, string | undefined>;

export type QaSquareSandboxConfig = {
  baseUrl: URL;
  supabaseUrl: string;
  serviceRoleKey: string;
  expectedProjectRef: string;
  localSupabase: boolean;
  localDbUrl: string | null;
  square: {
    merchantId: string;
    locationId: string;
    applicationId: string;
    accessToken: string;
    environment: "sandbox";
  };
  vercelBypassSecret: string | null;
  responseLossSecret: string;
  cronSecret: string;
};

class HarnessStop extends Error {
  constructor(
    readonly code: string,
    readonly providerMayHaveAccepted = false,
  ) {
    super(code);
    this.name = "HarnessStop";
  }
}

function stop(code: string, providerMayHaveAccepted = false): never {
  throw new HarnessStop(code, providerMayHaveAccepted);
}

function exact(env: Env, key: string): string {
  return env[key]?.trim() ?? "";
}

function projectRefFromUrl(raw: string): string | null {
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.(?:co|in)\/?$/i.exec(raw.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isProductionAppHost(hostname: string): boolean {
  return hostname === "nailiq.ca" || hostname.endsWith(".nailiq.ca") ||
    hostname === "nailiq.vercel.app" || hostname.endsWith(".nailiq.vercel.app");
}

function assertImmutableNonProductionBaseUrl(env: Env): URL {
  const raw = exact(env, "NAILIQ_QA_SQUARE_SANDBOX_BASE_URL");
  if (!raw) stop("base_url_required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    stop("base_url_invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) stop("base_url_must_be_origin_only");
  if (isProductionAppHost(hostname)) stop("production_app_host_forbidden");
  if (isLoopbackHost(hostname)) {
    if (url.protocol !== "http:" && url.protocol !== "https:") stop("local_protocol_invalid");
    return url;
  }
  const pinnedHost = exact(env, "NAILIQ_QA_IMMUTABLE_VERCEL_HOST").toLowerCase();
  if (
    url.protocol !== "https:" || !hostname.endsWith(".vercel.app") ||
    !pinnedHost || hostname !== pinnedHost || hostname.includes("-git-") ||
    !/^[a-z0-9-]+-[a-z0-9]{8,}-[a-z0-9-]+\.vercel\.app$/.test(hostname)
  ) stop("immutable_nonproduction_vercel_host_required");
  return url;
}

/** Pure, fail-closed preflight used by the static/unit regression suite. */
export function validateQaSquareSandboxConfig(
  env: Env,
  cliArgs: readonly string[] = [],
): QaSquareSandboxConfig {
  if (cliArgs.length !== 0) stop("cli_arguments_forbidden");
  if (exact(env, "NAILIQ_QA_SQUARE_SANDBOX_ONCE") !== "1") {
    stop("one_shot_gate_required");
  }
  if (exact(env, "DISABLE_OUTBOUND_SMS") !== "1") stop("sms_kill_switch_required");
  if (exact(env, "DISABLE_OUTBOUND_CALLS") !== "1") stop("calls_kill_switch_required");
  if (exact(env, "DISABLE_OUTBOUND_EMAIL") !== "1") stop("email_kill_switch_required");
  if (exact(env, "NAILIQ_QA_SQUARE_RESPONSE_LOSS_ENABLED") !== "1") {
    stop("response_loss_gate_required");
  }
  if (exact(env, "SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT") !== "sandbox") {
    stop("sandbox_reconciliation_environment_required");
  }
  if (exact(env, "PAYMENT_LEDGER_WORKERS_ENABLED") !== "true") {
    stop("payment_reconciliation_worker_required");
  }
  if (exact(env, "VERCEL_ENV") !== "preview" && exact(env, "VERCEL_ENV") !== "development") {
    stop("nonproduction_vercel_environment_required");
  }

  const baseUrl = assertImmutableNonProductionBaseUrl(env);
  const expectedProjectRef = exact(env, "NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF").toLowerCase();
  const supabaseUrl = exact(env, "NEXT_PUBLIC_SUPABASE_URL");
  const internalSupabaseUrl = exact(env, "SUPABASE_INTERNAL_URL");
  const serviceRoleKey = exact(env, "SUPABASE_SERVICE_ROLE_KEY");
  const localSupabase = exact(env, "NAILIQ_QA_LOCAL_SUPABASE") === "1";
  const localDbUrl = exact(env, "NAILIQ_QA_LOCAL_DB_URL");
  const actualProjectRef = projectRefFromUrl(supabaseUrl);
  if (localSupabase) {
    if (
      !isLoopbackHost(baseUrl.hostname.toLowerCase()) ||
      supabaseUrl !== LOCAL_SUPABASE_URL ||
      (internalSupabaseUrl && internalSupabaseUrl !== LOCAL_SUPABASE_URL) ||
      expectedProjectRef || exact(env, "E2E_EXPECTED_PROJECT_REF") ||
      localDbUrl !== LOCAL_POSTGRES_URL
    ) stop("paired_local_supabase_required");
  } else {
    if (localDbUrl) stop("local_postgres_url_forbidden_for_hosted");
    if (!PROJECT_REF_RE.test(expectedProjectRef)) stop("expected_supabase_project_ref_required");
    if (expectedProjectRef === PRODUCTION_SUPABASE_REF) stop("production_supabase_ref_forbidden");
    if (!actualProjectRef || actualProjectRef !== expectedProjectRef) {
      stop("supabase_project_ref_mismatch");
    }
    if (actualProjectRef === PRODUCTION_SUPABASE_REF) stop("production_supabase_ref_forbidden");
    if (internalSupabaseUrl && internalSupabaseUrl !== supabaseUrl) {
      stop("supabase_internal_url_mismatch");
    }
  }
  if (serviceRoleKey.length < 30) stop("nonproduction_service_role_required");

  const responseLossSecret = exact(env, "NAILIQ_QA_SQUARE_RESPONSE_LOSS_SECRET");
  const cronSecret = exact(env, "CRON_SECRET");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(responseLossSecret)) {
    stop("response_loss_secret_invalid");
  }
  if (cronSecret.length < 32 || cronSecret.length > 512) stop("cron_secret_invalid");

  if (exact(env, "NAILIQ_QA_SQUARE_ENVIRONMENT") !== "sandbox") {
    stop("square_sandbox_environment_required");
  }
  const merchantId = exact(env, "NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID");
  const locationId = exact(env, "NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID");
  const applicationId = exact(env, "NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID");
  const accessToken = exact(env, "NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN");
  if (!SQUARE_MERCHANT_RE.test(merchantId)) stop("square_sandbox_merchant_invalid");
  if (!SQUARE_LOCATION_RE.test(locationId)) stop("square_sandbox_location_invalid");
  if (!SANDBOX_APPLICATION_RE.test(applicationId)) stop("square_sandbox_application_invalid");
  if (!SQUARE_SANDBOX_TOKEN_RE.test(accessToken)) stop("square_sandbox_token_invalid");

  return {
    baseUrl,
    supabaseUrl,
    serviceRoleKey,
    expectedProjectRef: localSupabase ? "local" : expectedProjectRef,
    localSupabase,
    localDbUrl: localSupabase ? localDbUrl : null,
    square: {
      merchantId,
      locationId,
      applicationId,
      accessToken,
      environment: "sandbox",
    },
    vercelBypassSecret: exact(env, "NAILIQ_QA_VERCEL_BYPASS_SECRET") || null,
    responseLossSecret,
    cronSecret,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function timestampsRepresentSameInstant(left: unknown, right: unknown): boolean {
  const leftEpoch = Date.parse(string(left));
  const rightEpoch = Date.parse(string(right));
  return Number.isFinite(leftEpoch) && Number.isFinite(rightEpoch) && leftEpoch === rightEpoch;
}

/**
 * Read-only credential-pair preflight. It must run before any database fixture
 * or provider-capable app request so an access token from a different Square
 * application or merchant can never be combined with the submitted IDs.
 */
export async function preflightQaSquareSandboxCredentialPair(
  config: QaSquareSandboxConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(SQUARE_SANDBOX_TOKEN_STATUS, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.square.accessToken}`,
        "Square-Version": SQUARE_VERSION,
        Accept: "application/json",
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    stop("square_sandbox_token_status_unavailable");
  }

  const payload = record(await response.json().catch(() => null));
  if (!response.ok || !payload) {
    stop("square_sandbox_token_status_unavailable");
  }
  const tokenClientId = string(payload.client_id);
  const tokenMerchantId = string(payload.merchant_id);
  if (!tokenClientId || tokenClientId !== config.square.applicationId) {
    stop("square_sandbox_application_token_mismatch");
  }
  if (!tokenMerchantId || tokenMerchantId !== config.square.merchantId) {
    stop("square_sandbox_merchant_token_mismatch");
  }
}

function safeFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function emit(
  status: "NOT_RUN" | "RECONCILIATION_REQUIRED" | "FAILED_CLEANUP" | "PASS_SANDBOX",
  code: string,
  extra: Record<string, string | number | boolean> = {},
) {
  // Only fixed codes, booleans, counts, amounts and one-way receipt hashes are
  // emitted. No credential, capability token, phone, email or raw provider id.
  console.log(JSON.stringify({ status, code, ...extra }));
}

type MarkerStatus =
  | "provider_dispatch_started"
  | "reconciliation_required"
  | "reconciled"
  | "pass_sandbox"
  | "failed_cleanup";

function markerPayload(
  status: MarkerStatus,
  extra: Record<string, string | number | boolean> = {},
) {
  return {
    mqa: "MQA-0196",
    status,
    updated_at: new Date().toISOString(),
    ...extra,
  };
}

function writeDurableExclusive(path: string, contents: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function createOneShotMarker(operationId: string, targetHost: string): void {
  if (!existsSync(dirname(QA_SQUARE_SANDBOX_MARKER))) stop("one_shot_marker_directory_missing");
  try {
    writeDurableExclusive(
      QA_SQUARE_SANDBOX_MARKER,
      `${JSON.stringify(markerPayload("provider_dispatch_started", {
        operation_fingerprint: safeFingerprint(operationId),
        target_fingerprint: safeFingerprint(targetHost),
      }), null, 2)}\n`,
    );
  } catch {
    stop("one_shot_marker_exists_or_unavailable");
  }
}

function updateOneShotMarker(
  status: Exclude<MarkerStatus, "provider_dispatch_started">,
  extra: Record<string, string | number | boolean> = {},
): boolean {
  if (!existsSync(QA_SQUARE_SANDBOX_MARKER)) return false;
  const temporary = `${QA_SQUARE_SANDBOX_MARKER}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeDurableExclusive(
      temporary,
      `${JSON.stringify(markerPayload(status, extra), null, 2)}\n`,
    );
    renameSync(temporary, QA_SQUARE_SANDBOX_MARKER);
    return true;
  } catch {
    return false;
  }
}

function requestHeaders(config: QaSquareSandboxConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: config.baseUrl.origin,
    "sec-fetch-site": "same-origin",
    "user-agent": "NailIQ-MQA-0196-Square-Sandbox-One-Shot/1.0",
  };
  if (config.vercelBypassSecret) {
    headers["x-vercel-protection-bypass"] = config.vercelBypassSecret;
  }
  return headers;
}

async function appPost(
  config: QaSquareSandboxConfig,
  path: string,
  body: Record<string, unknown>,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(new URL(path, config.baseUrl), {
      method: "POST",
      headers: { ...requestHeaders(config), ...additionalHeaders },
      body: JSON.stringify(body),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    stop("app_request_transport_failure");
  }
  if (response.status >= 300 && response.status < 400) stop("app_redirect_forbidden");
  const parsed = record(await response.json().catch(() => null));
  if (!parsed) stop("app_response_invalid");
  return { status: response.status, body: parsed };
}

async function appGet(
  config: QaSquareSandboxConfig,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.cronSecret}`,
    "user-agent": "NailIQ-MQA-0196-Square-Sandbox-One-Shot/1.0",
  };
  if (config.vercelBypassSecret) {
    headers["x-vercel-protection-bypass"] = config.vercelBypassSecret;
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, config.baseUrl), {
      method: "GET",
      headers,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    stop("reconciliation_cron_transport_failure", true);
  }
  if (response.status >= 300 && response.status < 400) {
    stop("reconciliation_cron_redirect_forbidden", true);
  }
  const parsed = record(await response.json().catch(() => null));
  if (!parsed) stop("reconciliation_cron_response_invalid", true);
  return { status: response.status, body: parsed };
}

function startWindow(): { startTimeUtc: string; endTimeUtc: string } {
  const start = new Date(Date.now() + 72 * 60 * 60 * 1000);
  start.setUTCHours(12, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { startTimeUtc: start.toISOString(), endTimeUtc: end.toISOString() };
}

const OPEN_ALL_DAYS = {
  mon: { open: "00:00", close: "23:59", closed: false },
  tue: { open: "00:00", close: "23:59", closed: false },
  wed: { open: "00:00", close: "23:59", closed: false },
  thu: { open: "00:00", close: "23:59", closed: false },
  fri: { open: "00:00", close: "23:59", closed: false },
  sat: { open: "00:00", close: "23:59", closed: false },
  sun: { open: "00:00", close: "23:59", closed: false },
} as const;

async function assertFixtureAbsent(db: SupabaseClient) {
  const { data: byId, error: idError } = await db
    .from("salons")
    .select("id,slug")
    .eq("id", QA_SQUARE_SANDBOX_DEPOSIT.salonId)
    .maybeSingle();
  if (idError) stop("fixture_identity_preflight_failed");
  const { data: bySlug, error: slugError } = await db
    .from("salons")
    .select("id,slug")
    .eq("slug", QA_SQUARE_SANDBOX_DEPOSIT.slug)
    .maybeSingle();
  if (slugError) stop("fixture_identity_preflight_failed");
  if (byId || bySlug) stop("stale_fixture_requires_manual_review");
  const { data: profile, error: profileError } = await db
    .from("client_profiles")
    .select("id")
    .in("phone", [
      QA_SQUARE_SANDBOX_DEPOSIT.clientPhone,
      QA_SQUARE_SANDBOX_DEPOSIT.clientPhone.slice(1),
    ])
    .limit(1)
    .maybeSingle();
  if (profileError) stop("synthetic_phone_preflight_failed");
  if (profile) stop("synthetic_phone_not_clean");
}

async function seedFixture(
  db: SupabaseClient,
  config: QaSquareSandboxConfig,
) {
  const category = await db.from("service_categories").upsert({
    slug: "other",
    name_en: "Other",
    name_vi: "Khác",
    sort_order: 999,
  }, { onConflict: "slug", ignoreDuplicates: true });
  if (category.error) stop("fixture_category_failed");

  const salon = await db.from("salons").insert({
    id: QA_SQUARE_SANDBOX_DEPOSIT.salonId,
    slug: QA_SQUARE_SANDBOX_DEPOSIT.slug,
    name: "E2E Square Sandbox Deposit One Shot",
    phone: QA_SQUARE_SANDBOX_DEPOSIT.clientPhone,
    profile_complete: true,
    opening_hours: OPEN_ALL_DAYS,
    timezone: "UTC",
    currency_code: QA_SQUARE_SANDBOX_DEPOSIT.currency,
    booking_verification_mode: "always_deposit",
    deposit_pct_new_customer: 20,
    deposit_high_value_cents: 100_000,
    booking_lead_minutes: 0,
    setup_wizard_completed_at: new Date().toISOString(),
    payment_provider: "square",
    phone_otp_enabled: false,
    reminders_enabled: false,
    sms_reminders_enabled: false,
    sms_outbound_enabled: false,
    email_outbound_enabled: false,
  });
  if (salon.error) stop("fixture_salon_failed");

  const service = await db.from("services").insert({
    id: QA_SQUARE_SANDBOX_DEPOSIT.serviceId,
    salon_id: QA_SQUARE_SANDBOX_DEPOSIT.salonId,
    name: "QA Sandbox Deposit Service",
    price_cents: 500,
    duration_minutes: 30,
    buffer_minutes: 0,
    category: "other",
  });
  if (service.error) stop("fixture_service_failed");

  const staff = await db.from("staff").insert({
    id: QA_SQUARE_SANDBOX_DEPOSIT.staffId,
    salon_id: QA_SQUARE_SANDBOX_DEPOSIT.salonId,
    name: QA_SQUARE_SANDBOX_DEPOSIT.staffName,
    job_role: "nail_tech",
    status: "active",
  });
  if (staff.error) stop("fixture_staff_failed");
  const capability = await db.from("staff_services").insert({
    staff_id: QA_SQUARE_SANDBOX_DEPOSIT.staffId,
    service_id: QA_SQUARE_SANDBOX_DEPOSIT.serviceId,
  });
  if (capability.error) stop("fixture_staff_capability_failed");

  const square = await db.from("square_integrations").insert({
    salon_id: QA_SQUARE_SANDBOX_DEPOSIT.salonId,
    merchant_id: config.square.merchantId,
    location_id: config.square.locationId,
    application_id: config.square.applicationId,
    access_token: config.square.accessToken,
    environment: config.square.environment,
    enabled: true,
    deposit_enabled: true,
    reverse_create_enabled: false,
    sync_pull_create: false,
    sync_pull_update: false,
    sync_pull_cancel: false,
    sync_push_create: false,
    sync_push_update: false,
    sync_push_cancel: false,
    loyalty_sync_enabled: false,
    gift_cards_sync_enabled: false,
    inventory_sync_enabled: false,
  });
  if (square.error) stop("fixture_square_configuration_failed");
}

const QA_LOCAL_CLEANUP_SQL = String.raw`
DO $nailiq_qa_cleanup$
DECLARE
  qa_salon_id constant uuid := '${QA_SQUARE_SANDBOX_DEPOSIT.salonId}'::uuid;
  qa_slug constant text := '${QA_SQUARE_SANDBOX_DEPOSIT.slug}';
  qa_phone constant text := '${QA_SQUARE_SANDBOX_DEPOSIT.clientPhone}';
  qa_phone_without_country constant text := '${QA_SQUARE_SANDBOX_DEPOSIT.clientPhone.slice(1)}';
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'qa_local_cleanup_database_identity_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.salons
    WHERE (id = qa_salon_id AND slug <> qa_slug)
       OR (slug = qa_slug AND id <> qa_salon_id)
  ) THEN
    RAISE EXCEPTION 'qa_local_cleanup_fixture_identity_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bookings
    WHERE salon_id <> qa_salon_id
      AND client_phone IN (qa_phone, qa_phone_without_country)
  ) THEN
    RAISE EXCEPTION 'qa_local_cleanup_phone_collision';
  END IF;

  DELETE FROM public.booking_payment_operations WHERE salon_id = qa_salon_id;
  DELETE FROM public.bookings WHERE salon_id = qa_salon_id;
  DELETE FROM public.client_profiles WHERE phone IN (qa_phone, qa_phone_without_country);
  DELETE FROM public.salons WHERE id = qa_salon_id AND slug = qa_slug;

  IF EXISTS (SELECT 1 FROM public.salons WHERE id = qa_salon_id OR slug = qa_slug)
     OR EXISTS (SELECT 1 FROM public.services WHERE salon_id = qa_salon_id)
     OR EXISTS (SELECT 1 FROM public.staff WHERE salon_id = qa_salon_id)
     OR EXISTS (SELECT 1 FROM public.bookings WHERE salon_id = qa_salon_id)
     OR EXISTS (
       SELECT 1 FROM public.booking_payment_operations WHERE salon_id = qa_salon_id
     )
     OR EXISTS (
       SELECT 1 FROM public.client_profiles
       WHERE phone IN (qa_phone, qa_phone_without_country)
     ) THEN
    RAISE EXCEPTION 'qa_local_cleanup_verification_failed';
  END IF;
END
$nailiq_qa_cleanup$;
SELECT 'qa_local_cleanup_ok';
`;

async function cleanupLocalFixture(config: QaSquareSandboxConfig): Promise<boolean> {
  // Defense in depth at the destructive boundary: raw SQL is available only
  // for the exact paired loopback stack and the fixed Supabase local database.
  if (
    !config.localSupabase ||
    !isLoopbackHost(config.baseUrl.hostname.toLowerCase()) ||
    config.supabaseUrl !== LOCAL_SUPABASE_URL ||
    config.localDbUrl !== LOCAL_POSTGRES_URL
  ) return false;

  try {
    const { stdout } = await execFileAsync("psql", [
      "-X",
      "--set", "ON_ERROR_STOP=1",
      "--no-align",
      "--tuples-only",
      "--quiet",
      "--dbname", config.localDbUrl,
      "--command", QA_LOCAL_CLEANUP_SQL,
    ], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });
    return stdout.trim().split(/\s+/).includes("qa_local_cleanup_ok");
  } catch {
    return false;
  }
}

async function cleanupFixture(
  db: SupabaseClient,
  config: QaSquareSandboxConfig,
): Promise<boolean> {
  if (config.localSupabase) return cleanupLocalFixture(config);

  // Fixed IDs and an e2e-only slug make every delete narrowly scoped. The
  // hosted/non-local path retains the existing Data API boundary; raw database
  // cleanup is never enabled outside the exact paired loopback environment.
  const operations = await db.from("booking_payment_operations").delete()
    .eq("salon_id", QA_SQUARE_SANDBOX_DEPOSIT.salonId);
  if (operations.error) return false;
  const bookings = await db.from("bookings").delete()
    .eq("salon_id", QA_SQUARE_SANDBOX_DEPOSIT.salonId);
  if (bookings.error) return false;
  const profiles = await db.from("client_profiles").delete()
    .in("phone", [
      QA_SQUARE_SANDBOX_DEPOSIT.clientPhone,
      QA_SQUARE_SANDBOX_DEPOSIT.clientPhone.slice(1),
    ]);
  if (profiles.error) return false;
  const salon = await db.from("salons").delete()
    .eq("id", QA_SQUARE_SANDBOX_DEPOSIT.salonId)
    .eq("slug", QA_SQUARE_SANDBOX_DEPOSIT.slug);
  if (salon.error) return false;
  const checks = await Promise.all([
    db.from("salons").select("id", { count: "exact", head: true })
      .eq("id", QA_SQUARE_SANDBOX_DEPOSIT.salonId),
    db.from("services").select("id", { count: "exact", head: true })
      .eq("salon_id", QA_SQUARE_SANDBOX_DEPOSIT.salonId),
    db.from("staff").select("id", { count: "exact", head: true })
      .eq("salon_id", QA_SQUARE_SANDBOX_DEPOSIT.salonId),
    db.from("bookings").select("id", { count: "exact", head: true })
      .eq("salon_id", QA_SQUARE_SANDBOX_DEPOSIT.salonId),
    db.from("booking_payment_operations").select("id", { count: "exact", head: true })
      .eq("salon_id", QA_SQUARE_SANDBOX_DEPOSIT.salonId),
    db.from("client_profiles").select("id", { count: "exact", head: true })
      .in("phone", [
        QA_SQUARE_SANDBOX_DEPOSIT.clientPhone,
        QA_SQUARE_SANDBOX_DEPOSIT.clientPhone.slice(1),
      ]),
  ]);
  return checks.every(({ count, error }) => !error && (count ?? 0) === 0);
}

function canonicalIntent(
  quote: Record<string, unknown>,
  times: { startTimeUtc: string; endTimeUtc: string },
) {
  return {
    salonId: QA_SQUARE_SANDBOX_DEPOSIT.salonId,
    serviceId: QA_SQUARE_SANDBOX_DEPOSIT.serviceId,
    staffId: QA_SQUARE_SANDBOX_DEPOSIT.staffId,
    startTimeUtc: times.startTimeUtc,
    endTimeUtc: times.endTimeUtc,
    addonServiceIds: [],
    comboId: null,
    voucherId: null,
    clientPhone: QA_SQUARE_SANDBOX_DEPOSIT.clientPhone,
    clientEmail: null,
    applyEmailDiscount: false,
    bookingRequestId: QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId,
    paymentRequestId: QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId,
    expectedPricingFingerprint: string(quote.pricingFingerprint),
    otpSessionId: null,
  };
}

async function verifyPaidOperation(
  db: SupabaseClient,
  operationId: string,
  materialFingerprint: string,
) {
  const { data, error } = await db.from("booking_payment_operations")
    .select("id,salon_id,booking_id,request_id,operation_kind,provider,amount_cents,currency,status,provider_status,provider_payment_id,material_fingerprint,booking_intent_idempotency_key,failure_disposition,error_code,attempt_token,lease_expires_at,next_reconcile_at,completed_at,public_square_capability_consumed_at,result_json")
    .eq("id", operationId)
    .single();
  if (error || !data) stop("payment_receipt_missing", true);
  const result = record(data.result_json);
  const paymentId = string(data.provider_payment_id);
  if (
    data.id !== operationId || data.salon_id !== QA_SQUARE_SANDBOX_DEPOSIT.salonId ||
    data.request_id !== QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId ||
    data.booking_intent_idempotency_key !== QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId ||
    data.operation_kind !== "deposit_charge" || data.provider !== "square" ||
    data.amount_cents !== QA_SQUARE_SANDBOX_DEPOSIT.amountCents ||
    data.currency !== QA_SQUARE_SANDBOX_DEPOSIT.currency || data.status !== "succeeded" ||
    data.booking_id !== null || data.provider_status !== "COMPLETED" ||
    data.failure_disposition !== null || data.error_code !== null ||
    data.attempt_token !== null || data.lease_expires_at !== null ||
    data.next_reconcile_at !== null || !data.completed_at ||
    !Number.isFinite(Date.parse(data.completed_at)) ||
    !data.public_square_capability_consumed_at ||
    !Number.isFinite(Date.parse(data.public_square_capability_consumed_at)) ||
    data.material_fingerprint !== materialFingerprint || !paymentId ||
    result?.operation_id !== operationId || result?.provider_payment_id !== paymentId ||
    result?.salon_id !== QA_SQUARE_SANDBOX_DEPOSIT.salonId ||
    result?.provider !== "square" || result?.provider_status !== "COMPLETED" ||
    result?.amount_cents !== QA_SQUARE_SANDBOX_DEPOSIT.amountCents ||
    result?.currency !== QA_SQUARE_SANDBOX_DEPOSIT.currency || result?.status !== "succeeded"
  ) stop("payment_receipt_mismatch", true);
  return { paymentId, operation: data };
}

async function verifyUnknownOperation(
  db: SupabaseClient,
  operationId: string,
  materialFingerprint: string,
): Promise<string> {
  const { data, error } = await db.from("booking_payment_operations")
    .select("id,salon_id,booking_id,request_id,operation_kind,provider,delivery_mode,amount_cents,currency,status,provider_status,provider_payment_id,material_fingerprint,booking_intent_idempotency_key,failure_disposition,error_code,attempt_token,lease_expires_at,next_reconcile_at,completed_at,public_square_capability_consumed_at,result_json")
    .eq("id", operationId)
    .single();
  const nextReconcileAt = typeof data?.next_reconcile_at === "string"
    ? data.next_reconcile_at
    : "";
  if (
    error || !data || data.id !== operationId ||
    data.salon_id !== QA_SQUARE_SANDBOX_DEPOSIT.salonId || data.booking_id !== null ||
    data.request_id !== QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId ||
    data.booking_intent_idempotency_key !== QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId ||
    data.operation_kind !== "deposit_charge" || data.provider !== "square" ||
    data.delivery_mode !== "public_customer_present" ||
    data.amount_cents !== QA_SQUARE_SANDBOX_DEPOSIT.amountCents ||
    data.currency !== QA_SQUARE_SANDBOX_DEPOSIT.currency || data.status !== "unknown" ||
    data.provider_status !== null || data.provider_payment_id !== null ||
    data.material_fingerprint !== materialFingerprint ||
    data.failure_disposition !== "ambiguous" || data.error_code !== "provider_transport_error" ||
    data.attempt_token !== null || data.lease_expires_at !== null ||
    data.completed_at !== null || data.result_json !== null ||
    !data.public_square_capability_consumed_at ||
    !Number.isFinite(Date.parse(data.public_square_capability_consumed_at)) ||
    !nextReconcileAt || !Number.isFinite(Date.parse(nextReconcileAt))
  ) stop("response_loss_unknown_receipt_mismatch", true);
  return nextReconcileAt;
}

async function waitUntilReconciliationDue(
  db: SupabaseClient,
  operationId: string,
  materialFingerprint: string,
  initialNextReconcileAt: string,
): Promise<void> {
  const deadline = Date.now() + RECONCILIATION_WAIT_MS;
  let nextReconcileAt = initialNextReconcileAt;
  while (Date.parse(nextReconcileAt) > Date.now()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) stop("response_loss_reconciliation_wait_timeout", true);
    const untilDue = Date.parse(nextReconcileAt) - Date.now() + 250;
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(1_000, remaining, untilDue)));
    nextReconcileAt = await verifyUnknownOperation(db, operationId, materialFingerprint);
  }
}

async function verifyBoundBooking(
  db: SupabaseClient,
  operationId: string,
  bookingId: string,
  paymentId: string,
) {
  const [{ data: operation, error: operationError }, { data: booking, error: bookingError }] =
    await Promise.all([
      db.from("booking_payment_operations")
        .select("id,booking_id,provider_payment_id,result_json")
        .eq("id", operationId)
        .single(),
      db.from("bookings")
        .select("id,salon_id,idempotency_key,deposit_status,deposit_amount_cents,square_payment_id,verification_method,deposit_payment_ledger_enforced_at")
        .eq("id", bookingId)
        .single(),
    ]);
  const result = record(operation?.result_json);
  const bookingReceipt = record(result?.booking_create_result);
  if (
    operationError || bookingError || !operation || !booking ||
    operation.id !== operationId || operation.booking_id !== bookingId ||
    operation.provider_payment_id !== paymentId ||
    booking.id !== bookingId || booking.salon_id !== QA_SQUARE_SANDBOX_DEPOSIT.salonId ||
    booking.idempotency_key !== QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId ||
    booking.deposit_status !== "paid" ||
    booking.deposit_amount_cents !== QA_SQUARE_SANDBOX_DEPOSIT.amountCents ||
    booking.square_payment_id !== paymentId || booking.verification_method !== "deposit" ||
    !booking.deposit_payment_ledger_enforced_at || bookingReceipt?.booking_id !== bookingId
  ) stop("booking_receipt_mismatch", true);
}

export async function runQaSquareSandboxDepositOnce(
  env: Env = process.env,
  cliArgs: readonly string[] = process.argv.slice(2),
): Promise<void> {
  let config: QaSquareSandboxConfig;
  try {
    config = validateQaSquareSandboxConfig(env, cliArgs);
  } catch (error) {
    const code = error instanceof HarnessStop ? error.code : "preflight_failed";
    emit("NOT_RUN", code);
    process.exitCode = 2;
    return;
  }

  if (existsSync(QA_SQUARE_SANDBOX_MARKER)) {
    emit("NOT_RUN", "one_shot_marker_already_exists");
    process.exitCode = 2;
    return;
  }
  if (!existsSync(dirname(QA_SQUARE_SANDBOX_MARKER))) {
    emit("NOT_RUN", "one_shot_marker_directory_missing");
    process.exitCode = 2;
    return;
  }

  try {
    await preflightQaSquareSandboxCredentialPair(config);
  } catch (error) {
    const code = error instanceof HarnessStop
      ? error.code
      : "square_sandbox_token_status_unavailable";
    emit("NOT_RUN", code);
    process.exitCode = 2;
    return;
  }

  const db = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let fixtureSeeded = false;
  let providerDispatchAttempted = false;
  let markerCreated = false;
  let reconciliationProven = false;
  let completed = false;
  let finalCode = "unexpected_failure";
  let operationFingerprint = "";
  let receiptFingerprint = "";
  let bookingFingerprint = "";

  try {
    await assertFixtureAbsent(db);
    // From this point onward cleanup is required even when a later seed step
    // fails, because the salon insert may already have committed.
    fixtureSeeded = true;
    await seedFixture(db, config);
    const times = startWindow();

    const quoted = await appPost(config, "/api/booking/quote", {
      salonId: QA_SQUARE_SANDBOX_DEPOSIT.salonId,
      serviceId: QA_SQUARE_SANDBOX_DEPOSIT.serviceId,
      resolvedStaffId: QA_SQUARE_SANDBOX_DEPOSIT.staffId,
      resolvedStaffName: QA_SQUARE_SANDBOX_DEPOSIT.staffName,
      startTimeUtc: times.startTimeUtc,
      endTimeUtc: times.endTimeUtc,
      addonServiceIds: [],
      comboId: null,
      voucherCode: null,
      clientPhone: QA_SQUARE_SANDBOX_DEPOSIT.clientPhone,
      clientEmail: null,
      applyEmailDiscount: false,
    });
    const quote = record(quoted.body.quote);
    if (
      quoted.status !== 200 || quoted.body.ok !== true || !quote ||
      quote.salonId !== QA_SQUARE_SANDBOX_DEPOSIT.salonId ||
      quote.serviceId !== QA_SQUARE_SANDBOX_DEPOSIT.serviceId ||
      quote.resolvedStaffId !== QA_SQUARE_SANDBOX_DEPOSIT.staffId ||
      !timestampsRepresentSameInstant(quote.startTimeUtc, times.startTimeUtc) ||
      !timestampsRepresentSameInstant(quote.endTimeUtc, times.endTimeUtc) ||
      quote.currency !== QA_SQUARE_SANDBOX_DEPOSIT.currency ||
      quote.serviceOriginalCents !== 500 || !HASH_RE.test(string(quote.pricingFingerprint))
    ) stop("quote_receipt_mismatch");

    const intentBody = canonicalIntent(quote, times);
    const stageOne = await appPost(config, "/api/booking/deposit-intent", intentBody);
    const operationId = string(stageOne.body.operationId);
    const materialFingerprint = string(stageOne.body.materialFingerprint);
    const capabilityToken = string(stageOne.body.squareCapabilityToken);
    if (
      stageOne.status !== 200 || stageOne.body.required !== true ||
      stageOne.body.provider !== "square" ||
      stageOne.body.squareEnvironment !== "sandbox" ||
      stageOne.body.squareApplicationId !== config.square.applicationId ||
      stageOne.body.squareLocationId !== config.square.locationId ||
      stageOne.body.amountCents !== QA_SQUARE_SANDBOX_DEPOSIT.amountCents ||
      stageOne.body.currency !== QA_SQUARE_SANDBOX_DEPOSIT.currency ||
      stageOne.body.paymentRequestId !== QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId ||
      !UUID_RE.test(operationId) || !HASH_RE.test(materialFingerprint) ||
      capabilityToken.length < 32
    ) stop("square_stage_one_receipt_mismatch");

    operationFingerprint = safeFingerprint(operationId);
    // This durable flag is created atomically immediately before the only
    // provider-capable request. It is intentionally never removed, including
    // after fixture cleanup, so a later invocation cannot create payment #2.
    createOneShotMarker(operationId, config.baseUrl.hostname);
    markerCreated = true;
    providerDispatchAttempted = true;
    const stageTwo = await appPost(config, "/api/booking/deposit-intent", {
      operationId,
      paymentRequestId: QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId,
      squareCapabilityToken: capabilityToken,
      squareSourceToken: QA_SQUARE_SANDBOX_DEPOSIT.sourceToken,
    }, {
      [QA_RESPONSE_LOSS_HEADER]: config.responseLossSecret,
    }).catch(() => stop("square_stage_two_transport_uncertain", true));
    if (
      stageTwo.status !== 503 || stageTwo.body.error !== "deposit_pending" ||
      Object.prototype.hasOwnProperty.call(stageTwo.body, "paymentId") ||
      Object.prototype.hasOwnProperty.call(stageTwo.body, "providerPaymentId")
    ) stop("square_response_loss_not_observed", true);

    const nextReconcileAt = await verifyUnknownOperation(db, operationId, materialFingerprint);
    await waitUntilReconciliationDue(db, operationId, materialFingerprint, nextReconcileAt);
    const cron = await appGet(config, "/api/cron/payment-reconciliation");
    if (
      cron.status !== 200 || cron.body.ok !== true ||
      typeof cron.body.processed !== "number" || cron.body.processed < 1 ||
      typeof cron.body.succeeded !== "number" || cron.body.succeeded < 1
    ) stop("square_response_loss_reconciliation_cron_not_proven", true);
    const paid = await verifyPaidOperation(db, operationId, materialFingerprint);
    receiptFingerprint = safeFingerprint(paid.paymentId);
    reconciliationProven = true;
    if (!updateOneShotMarker("reconciled", {
      operation_fingerprint: operationFingerprint,
      payment_receipt_fingerprint: receiptFingerprint,
      response_loss_recovered: true,
    })) stop("one_shot_marker_reconciliation_update_failed", true);

    // Exact replay after a proven DB success cannot dispatch Square again: the
    // operation_replay branch returns before getSquareConfig/chargeCardToken.
    const stageTwoReplay = await appPost(config, "/api/booking/deposit-intent", {
      operationId,
      paymentRequestId: QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId,
      squareCapabilityToken: capabilityToken,
      squareSourceToken: QA_SQUARE_SANDBOX_DEPOSIT.sourceToken,
    });
    if (
      stageTwoReplay.status !== 200 || stageTwoReplay.body.paymentCompleted !== true ||
      stageTwoReplay.body.operationId !== operationId ||
      stageTwoReplay.body.materialFingerprint !== materialFingerprint
    ) stop("square_stage_two_replay_mismatch", true);

    const createBody = {
      salonId: QA_SQUARE_SANDBOX_DEPOSIT.salonId,
      serviceId: QA_SQUARE_SANDBOX_DEPOSIT.serviceId,
      staffId: QA_SQUARE_SANDBOX_DEPOSIT.staffId,
      clientName: QA_SQUARE_SANDBOX_DEPOSIT.clientName,
      clientPhone: QA_SQUARE_SANDBOX_DEPOSIT.clientPhone,
      startTimeUtc: times.startTimeUtc,
      endTimeUtc: times.endTimeUtc,
      clientNotes: null,
      addonServiceIds: [],
      clientEmail: null,
      resourceId: null,
      comboId: null,
      voucherId: null,
      applyEmailDiscount: false,
      idempotencyKey: QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId,
      pricingFingerprint: string(quote.pricingFingerprint),
      paymentOperationId: operationId,
      paymentRequestId: QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId,
      paymentMaterialFingerprint: materialFingerprint,
    };
    const created = await appPost(config, "/api/booking/deposit-create", createBody);
    const bookingId = string(created.body.booking_id);
    if (
      created.status !== 200 || created.body.success !== true ||
      created.body.code !== "booked_and_deposit_bound" ||
      created.body.idempotent !== false || !UUID_RE.test(bookingId)
    ) stop("deposit_booking_create_not_proven", true);
    await verifyBoundBooking(db, operationId, bookingId, paid.paymentId);
    bookingFingerprint = safeFingerprint(bookingId);

    const createReplay = await appPost(config, "/api/booking/deposit-create", createBody);
    if (
      createReplay.status !== 200 || createReplay.body.success !== true ||
      createReplay.body.code !== "booking_payment_replay" ||
      createReplay.body.idempotent !== true || createReplay.body.booking_id !== bookingId
    ) stop("deposit_booking_replay_mismatch", true);

    completed = true;
    finalCode = "quote_response_loss_cron_replay_create_receipts_verified";
  } catch (error) {
    if (error instanceof HarnessStop) {
      finalCode = error.code;
      providerDispatchAttempted ||= error.providerMayHaveAccepted;
    }
  }

  if (markerCreated && !completed) {
    updateOneShotMarker(
      reconciliationProven ? "reconciled" : "reconciliation_required",
      {
        operation_fingerprint: operationFingerprint,
        failure_code: finalCode,
        response_loss_recovered: reconciliationProven,
      },
    );
  }

  if (fixtureSeeded && (!providerDispatchAttempted || completed)) {
    let cleaned = false;
    try {
      cleaned = await cleanupFixture(db, config);
    } catch {
      cleaned = false;
    }
    if (!cleaned) {
      if (markerCreated) {
        updateOneShotMarker("failed_cleanup", {
          operation_fingerprint: operationFingerprint,
          payment_receipt_fingerprint: receiptFingerprint,
          booking_receipt_fingerprint: bookingFingerprint,
          failure_code: finalCode,
        });
      }
      emit(
        completed
          ? "FAILED_CLEANUP"
          : providerDispatchAttempted
            ? "RECONCILIATION_REQUIRED"
            : "NOT_RUN",
        "fixture_cleanup_failed",
        { originalFailureCode: finalCode },
      );
      process.exitCode = 2;
      return;
    }
  }

  if (!completed) {
    emit(
      providerDispatchAttempted ? "RECONCILIATION_REQUIRED" : "NOT_RUN",
      finalCode,
      { fixturePreserved: providerDispatchAttempted },
    );
    process.exitCode = 2;
    return;
  }

  updateOneShotMarker("pass_sandbox", {
    operation_fingerprint: operationFingerprint,
    payment_receipt_fingerprint: receiptFingerprint,
    booking_receipt_fingerprint: bookingFingerprint,
    response_loss_recovered: true,
    fixture_cleaned: true,
  });

  emit("PASS_SANDBOX", finalCode, {
    amountCents: QA_SQUARE_SANDBOX_DEPOSIT.amountCents,
    currencyCad: true,
    stageTwoReplay: true,
    bookingCreateReplay: true,
    responseLossRecovered: true,
    fixtureCleaned: true,
    paymentReceiptFingerprint: receiptFingerprint,
    bookingReceiptFingerprint: bookingFingerprint,
  });
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) {
  void runQaSquareSandboxDepositOnce();
}
