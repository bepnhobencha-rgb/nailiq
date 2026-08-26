import "server-only";

import {
  findExactSquarePaymentByReference,
  getSquareConfig,
  type ExactSquarePaymentQuery,
  type SquareConfig,
  type SquarePayment,
} from "./client";
import type { ClaimedPublicDepositPaymentOperation } from "@/shared/payments/bookingPaymentOperations";

type RpcResult = { data: unknown; error: unknown };

type SquareConfigDb = Parameters<typeof getSquareConfig>[0];

type ReconciliationDb = SquareConfigDb & {
  rpc: (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
};

type Dependencies = {
  getConfig?: (
    db: SquareConfigDb,
    salonId: string,
  ) => Promise<SquareConfig>;
  findPayment?: (
    config: SquareConfig,
    query: ExactSquarePaymentQuery,
  ) => Promise<SquarePayment | null>;
  now?: () => Date;
};

export type SquarePublicDepositReconciliationResult =
  | { status: "disabled" }
  | { status: "not_applicable" }
  | { status: "succeeded"; paymentId: string }
  | { status: "unknown"; reason: string }
  | { status: "completion_uncertain"; reason: string };

const CLOCK_SKEW_MS = 60 * 1_000;
const RECOVERY_WINDOW_MS = 20 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row !== null && typeof row === "object"
    ? row as Record<string, unknown>
    : null;
}

function enabledEnvironment(): "sandbox" | "production" | null {
  const value = process.env.SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT;
  return value === "sandbox" || value === "production" ? value : null;
}

function lookupWindow(
  claim: ClaimedPublicDepositPaymentOperation,
  operationCreatedAt: string,
  now: Date,
): ExactSquarePaymentQuery | null {
  const createdMs = Date.parse(operationCreatedAt);
  const nowMs = now.getTime();
  const beginMs = createdMs - CLOCK_SKEW_MS;
  const endMs = Math.min(createdMs + RECOVERY_WINDOW_MS, nowMs);
  if (
    !Number.isFinite(createdMs) || !Number.isFinite(nowMs) ||
    !Number.isFinite(beginMs) || !Number.isFinite(endMs) || beginMs >= endMs
  ) return null;
  return {
    referenceId: claim.material.bookingIdempotencyKey,
    amountCents: claim.material.amountCents,
    currency: claim.material.currency,
    beginTime: new Date(beginMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
  };
}

async function complete(
  db: ReconciliationDb,
  claim: ClaimedPublicDepositPaymentOperation,
  input: {
    outcome: "succeeded" | "unknown";
    providerStatus: string | null;
    paymentId: string | null;
    errorCode: "provider_outcome_ambiguous" | null;
  },
): Promise<RpcResult> {
  try {
    return await db.rpc("complete_booking_payment_operation", {
      p_operation_id: claim.operationId,
      p_attempt_token: claim.attemptToken,
      p_outcome: input.outcome,
      p_provider_status: input.providerStatus,
      p_provider_payment_id: input.paymentId,
      p_provider_refund_id: null,
      p_error_code: input.errorCode,
    });
  } catch {
    return { data: null, error: new Error("completion_write_uncertain") };
  }
}

async function completeUnknown(
  db: ReconciliationDb,
  claim: ClaimedPublicDepositPaymentOperation,
  storedPaymentId: string | null,
  reason: string,
): Promise<SquarePublicDepositReconciliationResult> {
  const completed = await complete(db, claim, {
    outcome: "unknown",
    providerStatus: null,
    paymentId: storedPaymentId,
    errorCode: "provider_outcome_ambiguous",
  });
  const row = record(completed.data);
  if (
    completed.error || row?.status !== "unknown" ||
    !["provider_outcome_unknown", "completion_replay"].includes(String(row.code ?? ""))
  ) {
    return { status: "completion_uncertain", reason };
  }
  return { status: "unknown", reason };
}

function configMatches(
  config: SquareConfig,
  claim: ClaimedPublicDepositPaymentOperation,
  environment: "sandbox" | "production",
): boolean {
  const provider = claim.material.providerMaterial;
  return claim.material.provider === "square" &&
    provider.providerEnvironment === environment &&
    config.environment === environment &&
    config.salonId === claim.material.salonId &&
    config.merchantId === provider.providerAccountId &&
    config.locationId === provider.providerLocationId &&
    config.applicationId === provider.providerApplicationId &&
    config.currency === claim.material.currency &&
    provider.currency === claim.material.currency &&
    provider.amountCents === claim.material.amountCents &&
    provider.bookingIntentReference === claim.material.bookingIdempotencyKey;
}

function receiptMatches(
  payment: SquarePayment,
  config: SquareConfig,
  query: ExactSquarePaymentQuery,
): boolean {
  const createdMs = typeof payment.created_at === "string"
    ? Date.parse(payment.created_at)
    : Number.NaN;
  return typeof payment.id === "string" && payment.id.length >= 1 && payment.id.length <= 255 &&
    payment.status === "COMPLETED" &&
    payment.reference_id === query.referenceId &&
    payment.location_id === config.locationId &&
    payment.application_details?.application_id === config.applicationId &&
    payment.amount_money?.amount === query.amountCents &&
    payment.amount_money?.currency === query.currency &&
    Number.isFinite(createdMs) &&
    createdMs >= Date.parse(query.beginTime) &&
    createdMs <= Date.parse(query.endTime);
}

/**
 * Read-only-at-provider recovery for a customer-present Square deposit whose
 * CreatePayment response was lost. Provider reads are explicitly environment
 * gated; every non-exact outcome remains unknown and is never re-charged.
 */
export async function reconcileSquarePublicDepositResponseLoss(
  db: ReconciliationDb,
  claim: ClaimedPublicDepositPaymentOperation,
  storedPaymentId: string | null,
  operationCreatedAt: string,
  dependencyInput: Dependencies = {},
): Promise<SquarePublicDepositReconciliationResult> {
  if (claim.material.provider !== "square") return { status: "not_applicable" };
  const environment = enabledEnvironment();
  if (!environment) return { status: "disabled" };
  if (claim.material.providerMaterial.providerEnvironment !== environment) {
    return completeUnknown(db, claim, storedPaymentId, "environment_mismatch");
  }
  const query = lookupWindow(
    claim,
    operationCreatedAt,
    dependencyInput.now?.() ?? new Date(),
  );
  if (!query) return completeUnknown(db, claim, storedPaymentId, "invalid_lookup_window");

  const loadConfig = dependencyInput.getConfig ?? getSquareConfig;
  const findPayment = dependencyInput.findPayment ?? findExactSquarePaymentByReference;
  let config: SquareConfig;
  try {
    config = await loadConfig(db, claim.material.salonId);
  } catch {
    return completeUnknown(db, claim, storedPaymentId, "configuration_unavailable");
  }
  if (!configMatches(config, claim, environment)) {
    return completeUnknown(db, claim, storedPaymentId, "provider_context_mismatch");
  }

  let payment: SquarePayment | null;
  try {
    payment = await findPayment(config, query);
  } catch {
    return completeUnknown(db, claim, storedPaymentId, "provider_lookup_ambiguous");
  }
  if (!payment) return completeUnknown(db, claim, storedPaymentId, "payment_not_found");
  if (
    !receiptMatches(payment, config, query) ||
    (storedPaymentId !== null && storedPaymentId !== payment.id)
  ) {
    return completeUnknown(db, claim, storedPaymentId, "provider_receipt_mismatch");
  }

  const completed = await complete(db, claim, {
    outcome: "succeeded",
    providerStatus: "COMPLETED",
    paymentId: payment.id,
    errorCode: null,
  });
  const row = record(completed.data);
  if (
    completed.error || row?.success !== true || row.status !== "succeeded" ||
    !["succeeded", "completion_replay"].includes(String(row.code ?? ""))
  ) {
    return { status: "completion_uncertain", reason: "success_completion_unavailable" };
  }
  return { status: "succeeded", paymentId: payment.id };
}
