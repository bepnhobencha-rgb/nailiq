/**
 * MQA-0196 guarded local recovery for the already-created Square Sandbox
 * payment whose CreatePayment response was intentionally lost.
 *
 * This is not a charge harness. It can only read the exact existing provider
 * receipt, claim the one preserved local ledger row through the dedicated
 * reconciliation RPC, persist that receipt, prove application/booking replay,
 * and remove the fixed synthetic local fixture. It has no CreatePayment or
 * cron path and accepts no CLI overrides.
 */

import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  parseClaimedPublicDepositPaymentOperation,
  parsePublicDepositPaymentMaterial,
  type ClaimedPublicDepositPaymentOperation,
  type PublicDepositPaymentMaterial,
} from "../src/shared/payments/bookingPaymentOperations";
import {
  QA_SQUARE_SANDBOX_DEPOSIT,
  QA_SQUARE_SANDBOX_MARKER,
  timestampsRepresentSameInstant,
} from "./qa-square-sandbox-deposit-once";

const execFileAsync = promisify(execFile);

const LOCAL_APP_ORIGIN = "http://127.0.0.1:3100";
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const LOCAL_POSTGRES_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SQUARE_SANDBOX_ORIGIN = "https://connect.squareupsandbox.com";
const SQUARE_VERSION = "2024-12-18";
const REQUEST_TIMEOUT_MS = 30_000;
const HASH_RE = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SQUARE_SANDBOX_TOKEN_RE = /^EAAA[A-Za-z0-9_-]{20,}$/;

/** Non-secret identities from the one preserved QA attempt. */
export const QA_SQUARE_SANDBOX_RECOVERY = {
  operationFingerprint: "59c443931e85e3fe",
  merchantId: "ML6GN287BBY4K",
  locationId: "L5VVHHWJMTEZB",
  frozenSdkApplicationId: "sandbox-sq0idb-S23JctKhfeikhPHDGCtQzg",
  tokenClientId: "sandbox-sq0idb-YYaF_rTSZaNpkw_wO7tcyg",
  operationCreatedAt: "2026-08-23T02:09:03.414014Z",
  paymentCreatedAt: "2026-08-23T02:09:04.072Z",
  providerWindowBegin: "2026-08-23T02:08:00.000Z",
} as const;
export const QA_SQUARE_SANDBOX_RECOVERY_JOURNAL =
  "/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/mqa-0196-square-sandbox-guarded-recovery-journal.json";

type Env = Record<string, string | undefined>;

export type QaSquareSandboxRecoveryConfig = {
  baseUrl: URL;
  supabaseUrl: typeof LOCAL_SUPABASE_URL;
  localDbUrl: typeof LOCAL_POSTGRES_URL;
  serviceRoleKey: string;
  signingSecret: string;
  squareAccessToken: string;
  tokenApplicationId: typeof QA_SQUARE_SANDBOX_RECOVERY.tokenClientId;
};

type Marker = {
  updatedAt: string;
  operationFingerprint: string;
};

export type QaSquareSandboxProviderEvidence = {
  paymentId: string;
  paymentFingerprint: string;
  tokenClientId: string;
  tokenClientFingerprint: string;
};

type UnknownOperationSnapshot = {
  operationId: string;
  operationFingerprint: string;
  materialFingerprint: string;
  stateFingerprint: string;
  createdAt: string;
  updatedAt: string;
  capabilityTokenHash: string;
  material: PublicDepositPaymentMaterial;
};

type PaidOperationSnapshot = UnknownOperationSnapshot & {
  paymentId: string;
};

type DbResult = { data: unknown; error: unknown };

type BoundedPaymentRead = {
  exactReferencePayments: unknown[];
  windowEnd: string;
};

class RecoveryStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RecoveryStop";
  }
}

function stop(code: string): never {
  throw new RecoveryStop(code);
}

function exact(env: Env, key: string): string {
  return env[key]?.trim() ?? "";
}

function record(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (candidate): candidate is Record<string, unknown> =>
          candidate !== null && typeof candidate === "object" && !Array.isArray(candidate),
      )
    : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function failClosedJson(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    stop("recovery_marker_unreadable");
  }
  const value = record(parsed);
  if (!value) stop("recovery_marker_invalid");
  return value;
}

/** Pure, exact validation of the preserved one-shot marker. */
export function validateQaSquareSandboxRecoveryMarker(value: unknown): Marker {
  const marker = record(value);
  const updatedAt = string(marker?.updated_at);
  const operationFingerprint = string(marker?.operation_fingerprint);
  if (
    marker?.mqa !== "MQA-0196" ||
    marker.status !== "reconciliation_required" ||
    marker.failure_code !== "square_response_loss_reconciliation_cron_not_proven" ||
    marker.response_loss_recovered !== false ||
    operationFingerprint !== QA_SQUARE_SANDBOX_RECOVERY.operationFingerprint ||
    !updatedAt || !Number.isFinite(Date.parse(updatedAt))
  ) stop("recovery_marker_state_mismatch");
  return { updatedAt, operationFingerprint };
}

function requireUnchangedRecoveryMarker(original: Marker): void {
  const current = validateQaSquareSandboxRecoveryMarker(
    failClosedJson(QA_SQUARE_SANDBOX_MARKER),
  );
  if (
    current.updatedAt !== original.updatedAt ||
    current.operationFingerprint !== original.operationFingerprint
  ) stop("recovery_marker_changed_concurrently");
}

/** Pure fail-closed preflight. Recovery is intentionally local-only. */
export function validateQaSquareSandboxRecoveryConfig(
  env: Env,
  cliArgs: readonly string[] = [],
): QaSquareSandboxRecoveryConfig {
  if (cliArgs.length !== 0) stop("cli_arguments_forbidden");
  if (exact(env, "NAILIQ_QA_SQUARE_SANDBOX_RECOVERY") !== "1") {
    stop("manual_recovery_gate_required");
  }
  if (exact(env, "NAILIQ_QA_SQUARE_SANDBOX_ONCE") !== "1") {
    stop("one_shot_gate_required");
  }
  if (exact(env, "DISABLE_OUTBOUND_SMS") !== "1") stop("sms_kill_switch_required");
  if (exact(env, "DISABLE_OUTBOUND_CALLS") !== "1") stop("calls_kill_switch_required");
  if (exact(env, "DISABLE_OUTBOUND_EMAIL") !== "1") stop("email_kill_switch_required");
  if (exact(env, "VERCEL_ENV") !== "development") stop("local_development_required");
  if (exact(env, "NODE_ENV") === "production") stop("production_node_environment_forbidden");
  if (exact(env, "NAILIQ_QA_LOCAL_SUPABASE") !== "1") stop("local_supabase_gate_required");
  if (exact(env, "SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT") !== "sandbox") {
    stop("sandbox_reconciliation_environment_required");
  }
  if (exact(env, "NAILIQ_QA_SQUARE_ENVIRONMENT") !== "sandbox") {
    stop("square_sandbox_environment_required");
  }

  const rawBaseUrl = exact(env, "NAILIQ_QA_SQUARE_SANDBOX_BASE_URL");
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    stop("exact_local_app_origin_required");
  }
  if (
    baseUrl.origin !== LOCAL_APP_ORIGIN || baseUrl.href !== `${LOCAL_APP_ORIGIN}/` ||
    baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
  ) stop("exact_local_app_origin_required");

  const supabaseUrl = exact(env, "NEXT_PUBLIC_SUPABASE_URL");
  const internalSupabaseUrl = exact(env, "SUPABASE_INTERNAL_URL");
  const localDbUrl = exact(env, "NAILIQ_QA_LOCAL_DB_URL");
  if (
    supabaseUrl !== LOCAL_SUPABASE_URL ||
    (internalSupabaseUrl && internalSupabaseUrl !== LOCAL_SUPABASE_URL) ||
    localDbUrl !== LOCAL_POSTGRES_URL ||
    exact(env, "NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF") ||
    exact(env, "E2E_EXPECTED_PROJECT_REF")
  ) stop("exact_local_supabase_pair_required");

  if (
    exact(env, "NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID") !==
      QA_SQUARE_SANDBOX_RECOVERY.merchantId ||
    exact(env, "NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID") !==
      QA_SQUARE_SANDBOX_RECOVERY.locationId ||
    exact(env, "NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID") !==
      QA_SQUARE_SANDBOX_RECOVERY.frozenSdkApplicationId
  ) stop("exact_square_sandbox_identity_required");
  if (
    exact(env, "NAILIQ_QA_SQUARE_SANDBOX_RECOVERY_TOKEN_APPLICATION_ID") !==
      QA_SQUARE_SANDBOX_RECOVERY.tokenClientId
  ) stop("exact_square_token_application_required");

  const squareAccessToken = exact(env, "NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN");
  if (!SQUARE_SANDBOX_TOKEN_RE.test(squareAccessToken)) {
    stop("square_sandbox_token_invalid");
  }
  const serviceRoleKey = exact(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (serviceRoleKey.length < 30) stop("local_service_role_required");
  const signingSecret = exact(env, "BOOKING_DEPOSIT_FINALIZE_SECRET") || serviceRoleKey;
  if (signingSecret.length < 30) stop("deposit_signing_secret_required");

  return {
    baseUrl,
    supabaseUrl: LOCAL_SUPABASE_URL,
    localDbUrl: LOCAL_POSTGRES_URL,
    serviceRoleKey,
    signingSecret,
    squareAccessToken,
    tokenApplicationId: QA_SQUARE_SANDBOX_RECOVERY.tokenClientId,
  };
}

function tokenScopes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((scope): scope is string => typeof scope === "string")
    : [];
}

/**
 * Pure validation for token status, the pinned Canada location, and the full
 * bounded ListPayments result. The token client id is intentionally distinct
 * from the immutable browser SDK app id frozen in the local ledger.
 */
export function validateQaSquareSandboxProviderEvidence(
  tokenStatusValue: unknown,
  locationValue: unknown,
  paymentValues: readonly unknown[],
  expectedTokenApplicationId: string = QA_SQUARE_SANDBOX_RECOVERY.tokenClientId,
): QaSquareSandboxProviderEvidence {
  const tokenStatus = record(tokenStatusValue);
  const locationEnvelope = record(locationValue);
  const location = record(locationEnvelope?.location);
  const scopes = tokenScopes(tokenStatus?.scopes);
  const tokenClientId = string(tokenStatus?.client_id);
  const tokenMerchantId = string(tokenStatus?.merchant_id);
  const expiresAt = string(tokenStatus?.expires_at);
  const frozenSdkApplicationId = String(
    QA_SQUARE_SANDBOX_RECOVERY.frozenSdkApplicationId,
  );
  if (
    expectedTokenApplicationId !== QA_SQUARE_SANDBOX_RECOVERY.tokenClientId ||
    tokenClientId !== expectedTokenApplicationId ||
    tokenClientId === frozenSdkApplicationId ||
    tokenMerchantId !== QA_SQUARE_SANDBOX_RECOVERY.merchantId ||
    !scopes.includes("PAYMENTS_READ") ||
    !expiresAt || !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.parse(QA_SQUARE_SANDBOX_RECOVERY.paymentCreatedAt)
  ) stop("square_token_status_mismatch");

  if (
    location?.id !== QA_SQUARE_SANDBOX_RECOVERY.locationId ||
    location.merchant_id !== QA_SQUARE_SANDBOX_RECOVERY.merchantId ||
    location.status !== "ACTIVE" || location.currency !== "CAD" ||
    location.country !== "CA"
  ) stop("square_location_mismatch");

  if (paymentValues.length !== 1) stop("square_payment_count_not_exactly_one");
  const payment = record(paymentValues[0]);
  const amount = record(payment?.amount_money);
  const application = record(payment?.application_details);
  const paymentId = string(payment?.id);
  const paymentCreatedAt = string(payment?.created_at);
  const receiptNumber = string(payment?.receipt_number);
  const receiptUrl = string(payment?.receipt_url);
  if (
    !paymentId || paymentId.length > 255 ||
    payment?.status !== "COMPLETED" || payment.reference_id !== QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId ||
    payment.location_id !== QA_SQUARE_SANDBOX_RECOVERY.locationId ||
    payment.source_type !== "CARD" ||
    amount?.amount !== QA_SQUARE_SANDBOX_DEPOSIT.amountCents || amount.currency !== "CAD" ||
    application?.application_id !== tokenClientId ||
    application.application_id === frozenSdkApplicationId ||
    !timestampsRepresentSameInstant(
      paymentCreatedAt,
      QA_SQUARE_SANDBOX_RECOVERY.paymentCreatedAt,
    ) ||
    Date.parse(paymentCreatedAt) < Date.parse(QA_SQUARE_SANDBOX_RECOVERY.providerWindowBegin) ||
    !receiptNumber || !receiptUrl
  ) stop("square_payment_receipt_mismatch");

  return {
    paymentId,
    paymentFingerprint: safeFingerprint(paymentId),
    tokenClientId,
    tokenClientFingerprint: safeFingerprint(tokenClientId),
  };
}

async function squareReadOnlyRequest(
  config: QaSquareSandboxRecoveryConfig,
  url: URL,
  method: "GET" | "POST",
): Promise<Record<string, unknown>> {
  if (
    url.origin !== SQUARE_SANDBOX_ORIGIN ||
    (method === "POST" && url.pathname !== "/oauth2/token/status") ||
    (method === "GET" && !(
      url.pathname === `/v2/locations/${QA_SQUARE_SANDBOX_RECOVERY.locationId}` ||
      url.pathname === "/v2/payments"
    ))
  ) stop("square_read_endpoint_forbidden");

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.squareAccessToken}`,
        "Square-Version": SQUARE_VERSION,
        Accept: "application/json",
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    stop("square_read_transport_failure");
  }
  const payload = record(await response.json().catch(() => null));
  if (!response.ok || !payload) stop("square_read_response_invalid");
  return payload;
}

async function readTokenStatus(config: QaSquareSandboxRecoveryConfig) {
  return squareReadOnlyRequest(
    config,
    new URL("/oauth2/token/status", SQUARE_SANDBOX_ORIGIN),
    "POST",
  );
}

async function readPinnedLocation(config: QaSquareSandboxRecoveryConfig) {
  return squareReadOnlyRequest(
    config,
    new URL(`/v2/locations/${QA_SQUARE_SANDBOX_RECOVERY.locationId}`, SQUARE_SANDBOX_ORIGIN),
    "GET",
  );
}

async function readBoundedPaymentsThroughNow(
  config: QaSquareSandboxRecoveryConfig,
): Promise<BoundedPaymentRead> {
  const exactReferencePayments: unknown[] = [];
  const windowEnd = new Date().toISOString();
  if (
    !Number.isFinite(Date.parse(windowEnd)) ||
    Date.parse(windowEnd) < Date.parse(QA_SQUARE_SANDBOX_RECOVERY.paymentCreatedAt)
  ) stop("square_payment_read_clock_invalid");
  let scannedCount = 0;
  let cursor = "";
  for (let page = 0; page < 10; page += 1) {
    const url = new URL("/v2/payments", SQUARE_SANDBOX_ORIGIN);
    url.searchParams.set("begin_time", QA_SQUARE_SANDBOX_RECOVERY.providerWindowBegin);
    url.searchParams.set("end_time", windowEnd);
    url.searchParams.set("location_id", QA_SQUARE_SANDBOX_RECOVERY.locationId);
    url.searchParams.set("sort_order", "ASC");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const payload = await squareReadOnlyRequest(config, url, "GET");
    const pagePayments = Array.isArray(payload.payments) ? payload.payments : [];
    scannedCount += pagePayments.length;
    if (scannedCount > 1_000) stop("square_payment_read_bound_exceeded");
    exactReferencePayments.push(...pagePayments.filter((payment) =>
      record(payment)?.reference_id === QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId
    ));
    cursor = string(payload.cursor);
    if (!cursor) return { exactReferencePayments, windowEnd };
  }
  stop("square_payment_pagination_incomplete");
}

function stateFingerprint(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({
    id: row.id,
    status: row.status,
    providerStatus: row.provider_status,
    providerPaymentId: row.provider_payment_id,
    attemptToken: row.attempt_token,
    attemptCount: row.attempt_count,
    nextReconcileAt: row.next_reconcile_at,
    updatedAt: row.updated_at,
    materialFingerprint: row.material_fingerprint,
    providerMaterial: row.provider_material,
    material: row.material_json,
  }), "utf8").digest("hex");
}

const OPERATION_SELECT = [
  "id", "salon_id", "booking_id", "request_id", "operation_kind", "provider",
  "provider_account_fingerprint", "amount_cents", "currency", "material_fingerprint",
  "material_json", "provider_material", "booking_intent_idempotency_key", "pricing_fingerprint",
  "service_id", "staff_id", "start_time_utc", "end_time_utc", "provider_payment_id",
  "provider_status", "provider_idempotency_key", "delivery_mode", "status",
  "failure_disposition", "error_code", "attempt_token", "attempt_count", "lease_expires_at",
  "next_reconcile_at", "created_at", "updated_at", "completed_at",
  "public_square_capability_token_hash", "public_square_capability_expires_at",
  "public_square_capability_consumed_at", "result_json",
].join(",");

async function loadExactOperationRow(db: SupabaseClient): Promise<Record<string, unknown>> {
  const { data, error } = await db.from("booking_payment_operations")
    .select(OPERATION_SELECT)
    .eq("salon_id", QA_SQUARE_SANDBOX_DEPOSIT.salonId)
    .eq("request_id", QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId)
    .limit(2);
  const rows = records(data);
  if (error || rows.length !== 1) stop("exact_local_operation_not_found");
  return rows[0];
}

function validateFrozenMaterial(
  row: Record<string, unknown>,
): PublicDepositPaymentMaterial {
  const fingerprint = string(row.material_fingerprint);
  const material = parsePublicDepositPaymentMaterial(row.material_json, fingerprint);
  if (
    !material || material.salonId !== QA_SQUARE_SANDBOX_DEPOSIT.salonId ||
    material.serviceId !== QA_SQUARE_SANDBOX_DEPOSIT.serviceId ||
    material.staffId !== QA_SQUARE_SANDBOX_DEPOSIT.staffId ||
    material.bookingIdempotencyKey !== QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId ||
    material.provider !== "square" || material.amountCents !== 100 || material.currency !== "CAD" ||
    material.providerMaterial.providerAccountId !== QA_SQUARE_SANDBOX_RECOVERY.merchantId ||
    material.providerMaterial.providerLocationId !== QA_SQUARE_SANDBOX_RECOVERY.locationId ||
    material.providerMaterial.providerApplicationId !==
      QA_SQUARE_SANDBOX_RECOVERY.frozenSdkApplicationId ||
    material.providerMaterial.providerEnvironment !== "sandbox" ||
    material.providerMaterial.bookingIntentReference !==
      QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId ||
    material.providerMaterial.amountCents !== 100 ||
    material.providerMaterial.currency !== "CAD" ||
    row.provider_account_fingerprint !== material.providerAccountFingerprint ||
    row.pricing_fingerprint !== material.pricingFingerprint ||
    row.service_id !== material.serviceId || row.staff_id !== material.staffId ||
    !timestampsRepresentSameInstant(row.start_time_utc, material.startTimeUtc) ||
    !timestampsRepresentSameInstant(row.end_time_utc, material.endTimeUtc)
  ) stop("frozen_payment_material_mismatch");
  return material;
}

async function loadUnknownOperation(db: SupabaseClient): Promise<UnknownOperationSnapshot> {
  const row = await loadExactOperationRow(db);
  const operationId = string(row.id);
  const operationFingerprint = safeFingerprint(operationId);
  const material = validateFrozenMaterial(row);
  const createdAt = string(row.created_at);
  const updatedAt = string(row.updated_at);
  const nextReconcileAt = string(row.next_reconcile_at);
  const capabilityTokenHash = string(row.public_square_capability_token_hash);
  if (
    !UUID_RE.test(operationId) ||
    operationFingerprint !== QA_SQUARE_SANDBOX_RECOVERY.operationFingerprint ||
    row.salon_id !== QA_SQUARE_SANDBOX_DEPOSIT.salonId || row.booking_id !== null ||
    row.request_id !== QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId ||
    row.operation_kind !== "deposit_charge" || row.provider !== "square" ||
    row.booking_intent_idempotency_key !== QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId ||
    row.amount_cents !== 100 || row.currency !== "CAD" ||
    row.provider_idempotency_key !== `nq:${operationId}` ||
    row.delivery_mode !== "public_customer_present" || row.status !== "unknown" ||
    row.provider_status !== null || row.provider_payment_id !== null ||
    row.failure_disposition !== "ambiguous" || row.error_code !== "provider_transport_error" ||
    row.attempt_token !== null || row.attempt_count !== 1 || row.lease_expires_at !== null ||
    row.completed_at !== null || row.result_json !== null ||
    !HASH_RE.test(material.materialFingerprint) || !HASH_RE.test(capabilityTokenHash) ||
    !string(row.public_square_capability_consumed_at) ||
    !Number.isFinite(Date.parse(string(row.public_square_capability_consumed_at))) ||
    !string(row.public_square_capability_expires_at) ||
    !Number.isFinite(Date.parse(string(row.public_square_capability_expires_at))) ||
    !timestampsRepresentSameInstant(createdAt, QA_SQUARE_SANDBOX_RECOVERY.operationCreatedAt) ||
    !updatedAt || !Number.isFinite(Date.parse(updatedAt)) ||
    !nextReconcileAt || !Number.isFinite(Date.parse(nextReconcileAt)) ||
    Date.parse(nextReconcileAt) > Date.now()
  ) stop("unknown_operation_state_mismatch");
  return {
    operationId,
    operationFingerprint,
    materialFingerprint: material.materialFingerprint,
    stateFingerprint: stateFingerprint(row),
    createdAt,
    updatedAt,
    capabilityTokenHash,
    material,
  };
}

function sameUnknownOperation(
  before: UnknownOperationSnapshot,
  after: UnknownOperationSnapshot,
): boolean {
  return before.operationId === after.operationId &&
    before.operationFingerprint === after.operationFingerprint &&
    before.materialFingerprint === after.materialFingerprint &&
    before.stateFingerprint === after.stateFingerprint &&
    before.createdAt === after.createdAt && before.updatedAt === after.updatedAt &&
    before.capabilityTokenHash === after.capabilityTokenHash;
}

async function claimExactRecoveryOperation(
  db: SupabaseClient,
  expected: UnknownOperationSnapshot,
): Promise<ClaimedPublicDepositPaymentOperation> {
  let result: DbResult;
  try {
    result = await db.rpc("discover_due_public_square_deposit_reconciliations", {
      p_expected_environment: "sandbox",
      p_limit: 2,
    });
  } catch {
    stop("dedicated_reconciliation_claim_unavailable");
  }
  const rows = records(result.data);
  if (result.error || rows.length !== 1) stop("dedicated_reconciliation_claim_not_exact");
  const claim = parseClaimedPublicDepositPaymentOperation(rows[0]);
  if (
    !claim || claim.operationId !== expected.operationId || claim.attemptCount !== 2 ||
    claim.material.materialFingerprint !== expected.materialFingerprint ||
    claim.material.provider !== "square" ||
    claim.material.providerMaterial.providerApplicationId !==
      QA_SQUARE_SANDBOX_RECOVERY.frozenSdkApplicationId ||
    claim.material.providerMaterial.providerAccountId !== QA_SQUARE_SANDBOX_RECOVERY.merchantId ||
    claim.material.providerMaterial.providerLocationId !== QA_SQUARE_SANDBOX_RECOVERY.locationId ||
    claim.material.providerMaterial.providerEnvironment !== "sandbox"
  ) stop("dedicated_reconciliation_claim_mismatch");
  return claim;
}

async function completeExactRecoveryOperation(
  db: SupabaseClient,
  claim: ClaimedPublicDepositPaymentOperation,
  paymentId: string,
): Promise<void> {
  let completed: DbResult;
  try {
    completed = await db.rpc("complete_booking_payment_operation", {
      p_operation_id: claim.operationId,
      p_attempt_token: claim.attemptToken,
      p_outcome: "succeeded",
      p_provider_status: "COMPLETED",
      p_provider_payment_id: paymentId,
      p_provider_refund_id: null,
      p_error_code: null,
    });
  } catch {
    stop("recovery_completion_write_uncertain");
  }
  if (completed.error) stop("recovery_completion_write_rejected");
  validateQaSquareSandboxRecoveryCompletion(
    completed.data,
    claim.operationId,
    claim.material.materialFingerprint,
  );
}

export function validateQaSquareSandboxRecoveryCompletion(
  value: unknown,
  expectedOperationId: string,
  expectedMaterialFingerprint: string,
): void {
  const row = record(value);
  if (
    !UUID_RE.test(expectedOperationId) || !HASH_RE.test(expectedMaterialFingerprint) ||
    row?.success !== true || row.code !== "succeeded_unbound" ||
    row.status !== "succeeded" || row.operation_id !== expectedOperationId ||
    row.material_fingerprint !== expectedMaterialFingerprint
  ) stop("recovery_completion_write_rejected");
}

export function deriveQaSquareRecoveryCapabilityToken(
  operationId: string,
  requestId: string,
  signingSecret: string,
): string {
  if (!UUID_RE.test(operationId) || !UUID_RE.test(requestId) || signingSecret.length < 30) {
    stop("capability_derivation_input_invalid");
  }
  const mac = createHmac("sha256", signingSecret)
    .update(`nailiq:public-square-deposit:v1:${operationId}:${requestId}`, "utf8")
    .digest("base64url");
  return `sq1.${mac}`;
}

async function loadPaidOperation(
  db: SupabaseClient,
  expected: UnknownOperationSnapshot,
  paymentId: string,
): Promise<PaidOperationSnapshot> {
  const row = await loadExactOperationRow(db);
  const material = validateFrozenMaterial(row);
  const result = record(row.result_json);
  if (
    row.id !== expected.operationId || safeFingerprint(string(row.id)) !== expected.operationFingerprint ||
    row.status !== "succeeded" || row.provider_status !== "COMPLETED" ||
    row.provider_payment_id !== paymentId || row.booking_id !== null ||
    row.failure_disposition !== null || row.error_code !== null ||
    row.attempt_token !== null || row.attempt_count !== 2 || row.lease_expires_at !== null ||
    row.next_reconcile_at !== null || !string(row.completed_at) ||
    !Number.isFinite(Date.parse(string(row.completed_at))) ||
    row.public_square_capability_token_hash !== expected.capabilityTokenHash ||
    material.materialFingerprint !== expected.materialFingerprint ||
    result?.operation_id !== expected.operationId || result.provider_payment_id !== paymentId ||
    result.provider_status !== "COMPLETED" || result.status !== "succeeded" ||
    result.salon_id !== QA_SQUARE_SANDBOX_DEPOSIT.salonId ||
    result.provider !== "square" || result.amount_cents !== 100 || result.currency !== "CAD"
  ) stop("paid_operation_receipt_mismatch");
  return {
    operationId: expected.operationId,
    operationFingerprint: expected.operationFingerprint,
    materialFingerprint: expected.materialFingerprint,
    stateFingerprint: stateFingerprint(row),
    createdAt: expected.createdAt,
    updatedAt: string(row.updated_at),
    capabilityTokenHash: expected.capabilityTokenHash,
    material,
    paymentId,
  };
}

function requestHeaders(config: QaSquareSandboxRecoveryConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: config.baseUrl.origin,
    "sec-fetch-site": "same-origin",
    "user-agent": "NailIQ-MQA-0196-Square-Sandbox-Guarded-Recovery/1.0",
  };
}

async function appPost(
  config: QaSquareSandboxRecoveryConfig,
  path: "/api/booking/deposit-intent",
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(new URL(path, config.baseUrl), {
      method: "POST",
      headers: requestHeaders(config),
      body: JSON.stringify(body),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    stop("local_app_transport_failure");
  }
  if (response.status >= 300 && response.status < 400) stop("local_app_redirect_forbidden");
  const parsed = record(await response.json().catch(() => null));
  if (!parsed) stop("local_app_response_invalid");
  return { status: response.status, body: parsed };
}

async function verifyStageTwoOperationReplay(
  config: QaSquareSandboxRecoveryConfig,
  paid: PaidOperationSnapshot,
  capabilityToken: string,
) {
  const replay = await appPost(config, "/api/booking/deposit-intent", {
    replayOnly: true,
    operationId: paid.operationId,
    paymentRequestId: QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId,
    squareCapabilityToken: capabilityToken,
  });
  if (
    replay.status !== 200 || replay.body.required !== true ||
    replay.body.paymentCompleted !== true || replay.body.operationId !== paid.operationId ||
    replay.body.paymentRequestId !== QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId ||
    replay.body.materialFingerprint !== paid.materialFingerprint
  ) stop("stage_two_operation_replay_mismatch");
}

function depositBookingRpcArgs(paid: PaidOperationSnapshot) {
  return {
    p_salon_id: QA_SQUARE_SANDBOX_DEPOSIT.salonId,
    p_service_id: QA_SQUARE_SANDBOX_DEPOSIT.serviceId,
    p_staff_id: QA_SQUARE_SANDBOX_DEPOSIT.staffId,
    p_client_name: QA_SQUARE_SANDBOX_DEPOSIT.clientName,
    p_client_phone: QA_SQUARE_SANDBOX_DEPOSIT.clientPhone,
    p_start_time_utc: paid.material.startTimeUtc,
    p_end_time_utc: paid.material.endTimeUtc,
    p_status: "confirmed",
    p_client_notes: null,
    p_addon_service_ids: [],
    p_client_email: null,
    p_resource_id: null,
    p_combo_id: null,
    p_voucher_id: null,
    p_apply_email_discount: false,
    p_idempotency_key: QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId,
    p_expected_pricing_fingerprint: paid.material.pricingFingerprint,
    p_payment_operation_id: paid.operationId,
    p_payment_request_id: QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId,
    p_expected_payment_material_fingerprint: paid.materialFingerprint,
  };
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
  const operationRow = record(operation);
  const bookingRow = record(booking);
  const result = record(operationRow?.result_json);
  const bookingReceipt = record(result?.booking_create_result);
  if (
    operationError || bookingError || !operationRow || !bookingRow ||
    operationRow.id !== operationId || operationRow.booking_id !== bookingId ||
    operationRow.provider_payment_id !== paymentId || bookingRow.id !== bookingId ||
    bookingRow.salon_id !== QA_SQUARE_SANDBOX_DEPOSIT.salonId ||
    bookingRow.idempotency_key !== QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId ||
    bookingRow.deposit_status !== "paid" || bookingRow.deposit_amount_cents !== 100 ||
    bookingRow.square_payment_id !== paymentId || bookingRow.verification_method !== "deposit" ||
    !bookingRow.deposit_payment_ledger_enforced_at || bookingReceipt?.booking_id !== bookingId
  ) stop("bound_booking_receipt_mismatch");
}

async function createAndReplayBooking(
  db: SupabaseClient,
  paid: PaidOperationSnapshot,
): Promise<string> {
  const args = depositBookingRpcArgs(paid);
  let created: DbResult;
  try {
    created = await db.rpc("create_public_booking_with_deposit_payment", args);
  } catch {
    stop("deposit_booking_create_write_uncertain");
  }
  const createdRow = record(created.data);
  const bookingId = string(createdRow?.booking_id);
  if (
    created.error || createdRow?.success !== true ||
    createdRow.code !== "booked_and_deposit_bound" || createdRow.idempotent !== false ||
    record(createdRow.booking)?.success !== true ||
    !UUID_RE.test(bookingId)
  ) stop("deposit_booking_create_not_proven");
  await verifyBoundBooking(db, paid.operationId, bookingId, paid.paymentId);

  let replay: DbResult;
  try {
    replay = await db.rpc("create_public_booking_with_deposit_payment", args);
  } catch {
    stop("deposit_booking_replay_write_uncertain");
  }
  const replayRow = record(replay.data);
  if (
    replay.error || replayRow?.success !== true ||
    replayRow.code !== "booking_payment_replay" || replayRow.idempotent !== true ||
    record(replayRow.booking)?.success !== true || replayRow.booking_id !== bookingId
  ) stop("deposit_booking_replay_mismatch");
  await verifyBoundBooking(db, paid.operationId, bookingId, paid.paymentId);
  return bookingId;
}

const QA_LOCAL_RECOVERY_CLEANUP_SQL = String.raw`
DO $nailiq_qa_recovery_cleanup$
DECLARE
  qa_salon_id constant uuid := '${QA_SQUARE_SANDBOX_DEPOSIT.salonId}'::uuid;
  qa_slug constant text := '${QA_SQUARE_SANDBOX_DEPOSIT.slug}';
  qa_phone constant text := '${QA_SQUARE_SANDBOX_DEPOSIT.clientPhone}';
  qa_phone_without_country constant text := '${QA_SQUARE_SANDBOX_DEPOSIT.clientPhone.slice(1)}';
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'qa_local_recovery_cleanup_database_identity_mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.salons
    WHERE (id = qa_salon_id AND slug <> qa_slug)
       OR (slug = qa_slug AND id <> qa_salon_id)
  ) THEN
    RAISE EXCEPTION 'qa_local_recovery_cleanup_fixture_identity_mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bookings
    WHERE salon_id <> qa_salon_id
      AND client_phone IN (qa_phone, qa_phone_without_country)
  ) THEN
    RAISE EXCEPTION 'qa_local_recovery_cleanup_phone_collision';
  END IF;

  DELETE FROM public.booking_payment_operations WHERE salon_id = qa_salon_id;
  DELETE FROM public.bookings WHERE salon_id = qa_salon_id;
  DELETE FROM public.client_profiles WHERE phone IN (qa_phone, qa_phone_without_country);
  DELETE FROM public.salons WHERE id = qa_salon_id AND slug = qa_slug;

  IF EXISTS (SELECT 1 FROM public.salons WHERE id = qa_salon_id OR slug = qa_slug)
     OR EXISTS (SELECT 1 FROM public.services WHERE salon_id = qa_salon_id)
     OR EXISTS (SELECT 1 FROM public.staff WHERE salon_id = qa_salon_id)
     OR EXISTS (SELECT 1 FROM public.bookings WHERE salon_id = qa_salon_id)
     OR EXISTS (SELECT 1 FROM public.booking_payment_operations WHERE salon_id = qa_salon_id)
     OR EXISTS (
       SELECT 1 FROM public.client_profiles
       WHERE phone IN (qa_phone, qa_phone_without_country)
     ) THEN
    RAISE EXCEPTION 'qa_local_recovery_cleanup_verification_failed';
  END IF;
END
$nailiq_qa_recovery_cleanup$;
SELECT 'qa_local_recovery_cleanup_ok';
`;

async function cleanupExactLocalFixture(config: QaSquareSandboxRecoveryConfig): Promise<void> {
  if (
    config.baseUrl.origin !== LOCAL_APP_ORIGIN ||
    config.supabaseUrl !== LOCAL_SUPABASE_URL ||
    config.localDbUrl !== LOCAL_POSTGRES_URL
  ) stop("local_cleanup_identity_mismatch");
  try {
    const { stdout } = await execFileAsync("psql", [
      "-X",
      "--set", "ON_ERROR_STOP=1",
      "--no-align",
      "--tuples-only",
      "--quiet",
      "--dbname", LOCAL_POSTGRES_URL,
      "--command", QA_LOCAL_RECOVERY_CLEANUP_SQL,
    ], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });
    if (!stdout.trim().split(/\s+/).includes("qa_local_recovery_cleanup_ok")) {
      stop("local_cleanup_verification_failed");
    }
  } catch (error) {
    if (error instanceof RecoveryStop) throw error;
    stop("local_cleanup_failed");
  }
}

function writeDurableJson(
  path: string,
  contents: Record<string, unknown>,
  mode: "create" | "replace",
): void {
  if (!existsSync(dirname(path))) stop("recovery_evidence_directory_missing");
  if (mode === "create") {
    if (existsSync(path)) stop("recovery_journal_already_exists");
    let descriptor: number | null = null;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      return;
    } catch {
      if (descriptor !== null) closeSync(descriptor);
      stop("recovery_journal_create_failed");
    }
  }

  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } catch {
    if (descriptor !== null) closeSync(descriptor);
    stop("recovery_evidence_update_failed");
  }
}

function writeRecoveryJournal(
  phase: string,
  input: {
    operationFingerprint: string;
    paymentFingerprint: string;
    tokenClientFingerprint: string;
    bookingFingerprint?: string;
    failureCode?: string;
    fixtureCleaned?: boolean;
  },
  mode: "create" | "replace" = "replace",
): void {
  writeDurableJson(QA_SQUARE_SANDBOX_RECOVERY_JOURNAL, {
    mqa: "MQA-0196",
    kind: "square_sandbox_guarded_recovery_journal",
    phase,
    updated_at: new Date().toISOString(),
    operation_fingerprint: input.operationFingerprint,
    payment_receipt_fingerprint: input.paymentFingerprint,
    token_client_fingerprint: input.tokenClientFingerprint,
    ...(input.bookingFingerprint
      ? { booking_receipt_fingerprint: input.bookingFingerprint }
      : {}),
    ...(input.failureCode ? { failure_code: input.failureCode } : {}),
    manual_guarded_recovery: true,
    cron_proven: false,
    provider_write_performed: false,
    fixture_cleaned: input.fixtureCleaned === true,
  }, mode);
}

function emit(
  status: "NOT_RUN" | "RECOVERY_INCOMPLETE" | "PASS_SANDBOX",
  code: string,
  extra: Record<string, string | number | boolean> = {},
) {
  // No raw provider id, capability, token, customer contact, or credential.
  console.log(JSON.stringify({ status, code, ...extra }));
}

export async function runQaSquareSandboxDepositRecovery(
  env: Env = process.env,
  cliArgs: readonly string[] = process.argv.slice(2),
): Promise<void> {
  let config: QaSquareSandboxRecoveryConfig;
  let originalMarker: Marker;
  try {
    config = validateQaSquareSandboxRecoveryConfig(env, cliArgs);
    if (!existsSync(QA_SQUARE_SANDBOX_MARKER)) stop("recovery_marker_missing");
    originalMarker = validateQaSquareSandboxRecoveryMarker(
      failClosedJson(QA_SQUARE_SANDBOX_MARKER),
    );
  } catch (error) {
    emit("NOT_RUN", error instanceof RecoveryStop ? error.code : "recovery_preflight_failed");
    process.exitCode = 2;
    return;
  }

  const db = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let mutationStarted = false;
  let paymentFingerprint = "";
  let tokenClientFingerprint = "";
  let bookingFingerprint = "";
  let journalCreated = false;
  let fixtureCleaned = false;
  let operationFingerprint = originalMarker.operationFingerprint;

  try {
    const initial = await loadUnknownOperation(db);
    operationFingerprint = initial.operationFingerprint;
    if (initial.operationFingerprint !== originalMarker.operationFingerprint) {
      stop("marker_operation_fingerprint_mismatch");
    }

    // Reconstruct and verify the already-consumed browser capability before a
    // journal or database mutation is allowed. Recovery never asks stage one
    // to mint or rotate a capability.
    const capabilityToken = deriveQaSquareRecoveryCapabilityToken(
      initial.operationId,
      QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId,
      config.signingSecret,
    );
    const capabilityHash = createHash("sha256")
      .update(capabilityToken, "utf8")
      .digest("hex");
    if (capabilityHash !== initial.capabilityTokenHash) stop("capability_hash_mismatch");

    const [tokenStatus, location, initialPaymentRead] = await Promise.all([
      readTokenStatus(config),
      readPinnedLocation(config),
      readBoundedPaymentsThroughNow(config),
    ]);
    const providerEvidence = validateQaSquareSandboxProviderEvidence(
      tokenStatus,
      location,
      initialPaymentRead.exactReferencePayments,
      config.tokenApplicationId,
    );
    paymentFingerprint = providerEvidence.paymentFingerprint;
    tokenClientFingerprint = providerEvidence.tokenClientFingerprint;

    // Provider reads must not race a local ledger change. Re-read the exact
    // unknown receipt before the first and only recovery mutation.
    const unchanged = await loadUnknownOperation(db);
    if (!sameUnknownOperation(initial, unchanged)) stop("operation_changed_during_provider_read");

    // Durable staged evidence is created before the first DB mutation. If the
    // process dies after the RPC dispatch, this phase means the claim may have
    // occurred and must be inspected rather than retried blindly.
    requireUnchangedRecoveryMarker(originalMarker);
    writeRecoveryJournal("db_claim_starting", {
      operationFingerprint,
      paymentFingerprint,
      tokenClientFingerprint,
    }, "create");
    journalCreated = true;
    mutationStarted = true;
    const claim = await claimExactRecoveryOperation(db, unchanged);
    writeRecoveryJournal("db_reconciliation_claimed", {
      operationFingerprint,
      paymentFingerprint,
      tokenClientFingerprint,
    });
    await completeExactRecoveryOperation(db, claim, providerEvidence.paymentId);
    const paid = await loadPaidOperation(db, unchanged, providerEvidence.paymentId);
    writeRecoveryJournal("ledger_succeeded", {
      operationFingerprint,
      paymentFingerprint,
      tokenClientFingerprint,
    });

    if (paid.capabilityTokenHash !== initial.capabilityTokenHash) {
      stop("paid_capability_hash_changed");
    }

    // This request carries no QA fault header. The paid operation_replay DB
    // branch returns before Square configuration or charge dispatch.
    await verifyStageTwoOperationReplay(config, paid, capabilityToken);
    writeRecoveryJournal("stage_two_operation_replay_succeeded", {
      operationFingerprint,
      paymentFingerprint,
      tokenClientFingerprint,
    });
    const bookingId = await createAndReplayBooking(db, paid);
    bookingFingerprint = safeFingerprint(bookingId);
    writeRecoveryJournal("booking_create_and_replay_succeeded", {
      operationFingerprint,
      paymentFingerprint,
      tokenClientFingerprint,
      bookingFingerprint,
    });

    const finalPaymentRead = await readBoundedPaymentsThroughNow(config);
    if (Date.parse(finalPaymentRead.windowEnd) < Date.parse(initialPaymentRead.windowEnd)) {
      stop("final_provider_read_window_regressed");
    }
    const finalEvidence = validateQaSquareSandboxProviderEvidence(
      tokenStatus,
      location,
      finalPaymentRead.exactReferencePayments,
      config.tokenApplicationId,
    );
    if (
      finalEvidence.paymentId !== providerEvidence.paymentId ||
      finalEvidence.paymentFingerprint !== providerEvidence.paymentFingerprint ||
      finalEvidence.tokenClientId !== providerEvidence.tokenClientId
    ) stop("final_provider_payment_count_changed");
    writeRecoveryJournal("final_provider_read_verified", {
      operationFingerprint,
      paymentFingerprint,
      tokenClientFingerprint,
      bookingFingerprint,
    });

    // Do not erase the fixture until local and provider replays are both proven.
    requireUnchangedRecoveryMarker(originalMarker);
    await cleanupExactLocalFixture(config);
    fixtureCleaned = true;
    writeRecoveryJournal("fixture_cleaned", {
      operationFingerprint,
      paymentFingerprint,
      tokenClientFingerprint,
      bookingFingerprint,
      fixtureCleaned,
    });

    requireUnchangedRecoveryMarker(originalMarker);
    writeDurableJson(QA_SQUARE_SANDBOX_MARKER, {
      mqa: "MQA-0196",
      status: "pass_sandbox",
      updated_at: new Date().toISOString(),
      operation_fingerprint: unchanged.operationFingerprint,
      payment_receipt_fingerprint: paymentFingerprint,
      booking_receipt_fingerprint: bookingFingerprint,
      token_client_fingerprint: tokenClientFingerprint,
      manual_guarded_recovery: true,
      cron_proven: false,
      response_loss_recovered: true,
      stage_two_operation_replay: true,
      booking_create_replay: true,
      provider_payment_count: 1,
      fixture_cleaned: true,
    }, "replace");
    writeRecoveryJournal("complete", {
      operationFingerprint,
      paymentFingerprint,
      tokenClientFingerprint,
      bookingFingerprint,
      fixtureCleaned,
    });

    emit("PASS_SANDBOX", "manual_guarded_response_loss_recovery_verified", {
      amountCents: 100,
      currencyCad: true,
      providerPaymentCount: 1,
      manualGuardedRecovery: true,
      cronProven: false,
      stageTwoOperationReplay: true,
      bookingCreateReplay: true,
      fixtureCleaned: true,
      paymentReceiptFingerprint: paymentFingerprint,
      bookingReceiptFingerprint: bookingFingerprint,
      tokenClientFingerprint,
    });
  } catch (error) {
    const failureCode = error instanceof RecoveryStop
      ? error.code
      : "guarded_recovery_failed";
    if (journalCreated) {
      try {
        writeRecoveryJournal("incomplete", {
          operationFingerprint,
          paymentFingerprint,
          tokenClientFingerprint,
          bookingFingerprint: bookingFingerprint || undefined,
          failureCode,
          fixtureCleaned,
        });
      } catch {
        // Preserve the original fixed failure code; the last durable phase is
        // still evidence of the exact boundary reached.
      }
    }
    emit(
      mutationStarted ? "RECOVERY_INCOMPLETE" : "NOT_RUN",
      failureCode,
      {
        fixturePreserved: !fixtureCleaned,
        fixtureCleaned,
        mutationStarted,
        ...(paymentFingerprint ? { paymentReceiptFingerprint: paymentFingerprint } : {}),
        ...(tokenClientFingerprint ? { tokenClientFingerprint } : {}),
        ...(bookingFingerprint ? { bookingReceiptFingerprint: bookingFingerprint } : {}),
      },
    );
    process.exitCode = 2;
  }
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) {
  void runQaSquareSandboxDepositRecovery();
}
