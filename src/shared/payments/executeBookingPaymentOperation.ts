import "server-only";

import type { PaymentProvider } from "@/shared/integrations/payments";
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import type { ClaimedBookingPaymentOperation } from "./bookingPaymentOperations";
import {
  parseBookingPaymentOperationMaterial,
  parseClaimedBookingPaymentOperation,
  type BookingPaymentOperationKind,
} from "./bookingPaymentOperations";

type RpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
};

export type PaymentDispatchOutcome =
  | { ok: true; status: "succeeded"; operationId: string; providerReceipt: string }
  | { ok: false; status: "pending_provider" | "definite_failure" | "unknown"; operationId: string; reason: string };

export type BookingPaymentRunOutcome = PaymentDispatchOutcome |
  { ok: false; status: "not_claimed"; operationId: string | null; reason: string };

type Completion = {
  outcome: "pending_provider" | "succeeded" | "definite_failure" | "unknown";
  providerStatus: string;
  paymentId?: string;
  refundId?: string;
  errorCode?: string;
};

function providerOutcome(
  provider: "square" | "stripe",
  kind: ClaimedBookingPaymentOperation["material"]["operationKind"],
  receipt: { id: string; status: string },
): Completion {
  const status = receipt.status.trim();
  const normalized = provider === "stripe" ? status.toLowerCase() : status.toUpperCase();
  const succeeded = provider === "stripe"
    ? normalized === "succeeded"
    : normalized === "COMPLETED";
  const isRefund = kind === "deposit_refund" || kind === "noshow_refund" ||
    kind === "late_cancel_refund";
  const pending = provider === "stripe"
    ? ["processing", "requires_capture", "pending"].includes(normalized)
    : ["PENDING", "OPEN", "APPROVED"].includes(normalized);
  if (succeeded) {
    return {
      outcome: "succeeded",
      providerStatus: status,
      ...(isRefund ? { refundId: receipt.id } : { paymentId: receipt.id }),
    };
  }
  if (pending) {
    return {
      outcome: "pending_provider",
      providerStatus: status,
      ...(isRefund ? { refundId: receipt.id } : { paymentId: receipt.id }),
    };
  }
  if (
    provider === "stripe" && !isRefund &&
    ["requires_payment_method", "requires_action"].includes(normalized)
  ) {
    return {
      outcome: "definite_failure",
      providerStatus: status,
      errorCode: normalized === "requires_action"
        ? "authentication_required"
        : "invalid_payment_method",
    };
  }
  if (["failed", "canceled", "cancelled", "declined", "rejected"].includes(normalized.toLowerCase())) {
    return {
      outcome: "definite_failure",
      providerStatus: status,
      errorCode: "provider_rejected",
    };
  }
  return {
    outcome: "unknown",
    providerStatus: status,
    ...(isRefund ? { refundId: receipt.id } : { paymentId: receipt.id }),
    errorCode: "provider_outcome_ambiguous",
  };
}

function definiteProviderError(error: unknown): string | null {
  const row = error && typeof error === "object"
    ? error as Record<string, unknown>
    : null;
  const code = String(row?.decline_code ?? row?.code ?? "").trim().toLowerCase();
  if (["card_declined", "expired_card", "insufficient_funds", "authentication_required"].includes(code)) {
    return code;
  }
  if (["payment_method_unactivated", "invalid_payment_method"].includes(code)) {
    return "invalid_payment_method";
  }
  return null;
}

async function complete(
  db: RpcClient,
  claim: ClaimedBookingPaymentOperation,
  completion: Completion,
): Promise<{ data: unknown; error: unknown }> {
  return db.rpc("complete_booking_payment_operation", {
    p_operation_id: claim.operationId,
    p_attempt_token: claim.attemptToken,
    p_outcome: completion.outcome,
    p_provider_status: completion.providerStatus || null,
    p_provider_payment_id: completion.paymentId ?? null,
    p_provider_refund_id: completion.refundId ?? null,
    p_error_code: completion.errorCode ?? null,
  });
}

/**
 * Executes one already-claimed DB-owned operation. No caller money, account,
 * card or parent receipt enters this function. Provider ambiguity is persisted
 * as unknown and is never converted into a retryable failure.
 */
export async function dispatchClaimedBookingPaymentOperation(args: {
  db: RpcClient;
  claim: ClaimedBookingPaymentOperation;
  provider?: PaymentProvider;
  providerPurpose?: "approved_no_show_charge" | "approved_cancellation_fee";
  note?: string;
  referenceId?: string;
  reason?: string;
}): Promise<PaymentDispatchOutcome> {
  const { claim } = args;
  if (args.providerPurpose === "approved_no_show_charge" &&
      claim.material.operationKind !== "noshow_charge") {
    return {
      ok: false,
      status: "unknown",
      operationId: claim.operationId,
      reason: "provider_purpose_mismatch",
    };
  }
  if (args.providerPurpose === "approved_cancellation_fee" &&
      claim.material.operationKind !== "late_cancel_charge") {
    return {
      ok: false,
      status: "unknown",
      operationId: claim.operationId,
      reason: "provider_purpose_mismatch",
    };
  }
  let provider: PaymentProvider;
  try {
    provider = args.provider ?? await resolvePaymentProvider(
      claim.material.salonId,
      { strict: true, purpose: args.providerPurpose },
    ) as PaymentProvider;
  } catch {
    const completion: Completion = {
      outcome: "unknown",
      providerStatus: "",
      errorCode: "provider_outcome_ambiguous",
    };
    await complete(args.db, claim, completion).catch(() => undefined);
    return {
      ok: false,
      status: "unknown",
      operationId: claim.operationId,
      reason: "provider_configuration_unavailable",
    };
  }
  if (!provider || provider.kind !== claim.material.provider) {
    const completion: Completion = {
      outcome: "unknown",
      providerStatus: "",
      errorCode: "provider_outcome_ambiguous",
    };
    await complete(args.db, claim, completion).catch(() => undefined);
    return {
      ok: false,
      status: "unknown",
      operationId: claim.operationId,
      reason: "provider_material_mismatch",
    };
  }

  let completion: Completion;
  try {
    const isRefund = claim.material.operationKind === "deposit_refund" ||
      claim.material.operationKind === "noshow_refund" ||
      claim.material.operationKind === "late_cancel_refund";
    const receipt = isRefund
      ? await provider.refund({
          paymentId: claim.material.parentPaymentId!,
          amountCents: claim.material.amountCents,
          reason: args.reason ?? "Booking payment refund",
          idempotencyKey: claim.providerIdempotencyKey,
          providerAccountId: claim.material.providerMaterial.providerAccountId,
          providerLocationId: claim.material.providerMaterial.providerLocationId,
          providerEnvironment: claim.material.providerMaterial.providerEnvironment,
          providerCurrency: claim.material.providerMaterial.currency,
          providerAccountFingerprint: claim.material.providerAccountFingerprint,
        }).then((result) => ({ id: result.refundId, status: result.status }))
      : await provider.chargeSavedCard({
          customerId: claim.material.providerMaterial.customerId!,
          cardId: claim.material.providerMaterial.savedCardId!,
          amountCents: claim.material.amountCents,
          idempotencyKey: claim.providerIdempotencyKey,
          note: args.note ?? "Booking payment",
          referenceId: args.referenceId ?? `booking:${claim.material.bookingId}`,
          providerAccountId: claim.material.providerMaterial.providerAccountId,
          providerLocationId: claim.material.providerMaterial.providerLocationId,
          providerEnvironment: claim.material.providerMaterial.providerEnvironment,
          providerCurrency: claim.material.providerMaterial.currency,
          providerAccountFingerprint: claim.material.providerAccountFingerprint,
        }).then((result) => ({ id: result.paymentId, status: result.status }));
    completion = providerOutcome(provider.kind, claim.material.operationKind, receipt);
  } catch (error) {
    const definite = definiteProviderError(error);
    completion = definite
      ? {
          outcome: "definite_failure",
          providerStatus: "",
          errorCode: definite,
        }
      : {
          outcome: "unknown",
          providerStatus: "",
          errorCode: "provider_transport_error",
        };
  }

  let completed: { data: unknown; error: unknown };
  try {
    completed = await complete(args.db, claim, completion);
  } catch {
    completed = { data: null, error: new Error("completion_write_uncertain") };
  }
  if (completed.error) {
    return {
      ok: false,
      status: "unknown",
      operationId: claim.operationId,
      reason: "completion_write_uncertain",
    };
  }
  const row = Array.isArray(completed.data) ? completed.data[0] : completed.data;
  const result = row && typeof row === "object" ? row as Record<string, unknown> : null;
  if (completion.outcome === "succeeded" && result?.success === true &&
      (result.code === "succeeded" || result.code === "completion_replay")) {
    return {
      ok: true,
      status: "succeeded",
      operationId: claim.operationId,
      providerReceipt: completion.paymentId ?? completion.refundId!,
    };
  }
  return {
    ok: false,
    status: completion.outcome === "succeeded" ? "unknown" : completion.outcome,
    operationId: claim.operationId,
    reason: typeof result?.code === "string" ? result.code : completion.errorCode ?? "payment_incomplete",
  };
}

/** Load authoritative money, reserve one logical operation, then dispatch it. */
export async function runAuthoritativeBookingPaymentOperation(args: {
  db: RpcClient;
  salonId: string;
  bookingId: string;
  requestId: string;
  operationKind: BookingPaymentOperationKind;
  amountCents?: number | null;
  provider?: PaymentProvider;
  note?: string;
  referenceId?: string;
  reason?: string;
  paymentAuthorization?: {
    kind: "approved_no_show_fee";
    reviewId: string;
  };
}): Promise<BookingPaymentRunOutcome> {
  // Attendance and cancellation never authorize money movement. No-show fees
  // may enter the provider ledger only through the owner/admin approval flow,
  // whose immutable receipt is rechecked by SQL. Late-cancel charging has no
  // equivalent approval receipt yet and therefore remains fail-closed.
  if (args.operationKind === "late_cancel_charge") {
    return {
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: "fee_approval_required",
    };
  }
  if (
    args.operationKind === "noshow_charge" &&
    (args.paymentAuthorization?.kind !== "approved_no_show_fee" ||
      !args.paymentAuthorization.reviewId)
  ) {
    return {
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: "fee_approval_required",
    };
  }

  // Exact response-loss replay must win before reading mutable booking state.
  // This is especially important for cancellation/no-show lifecycle changes:
  // a committed operation remains recoverable by its stable logical request.
  let inspected: { data: unknown; error: unknown };
  try {
    inspected = await args.db.rpc("inspect_booking_payment_operation", {
      p_salon_id: args.salonId,
      p_booking_id: args.bookingId,
      p_request_id: args.requestId,
      p_operation_kind: args.operationKind,
    });
  } catch {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_inspection_unavailable" };
  }
  if (inspected.error) {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_inspection_unavailable" };
  }
  const inspectedRaw = Array.isArray(inspected.data) ? inspected.data[0] : inspected.data;
  const inspectedRow = inspectedRaw && typeof inspectedRaw === "object"
    ? inspectedRaw as Record<string, unknown>
    : null;
  if (inspectedRow?.success === true && inspectedRow.code === "operation_loaded") {
    const operationId = typeof inspectedRow.operation_id === "string"
      ? inspectedRow.operation_id
      : null;
    const fingerprint = typeof inspectedRow.material_fingerprint === "string"
      ? inspectedRow.material_fingerprint
      : null;
    const storedMaterial = fingerprint
      ? parseBookingPaymentOperationMaterial(
          {
            ...(inspectedRow.material as Record<string, unknown> | null ?? {}),
            material_fingerprint: fingerprint,
          },
          args.operationKind,
        )
      : null;
    if (
      !operationId || !fingerprint || !storedMaterial ||
      storedMaterial.salonId !== args.salonId || storedMaterial.bookingId !== args.bookingId
    ) {
      return { ok: false, status: "not_claimed", operationId, reason: "payment_replay_material_invalid" };
    }
    // A stable request UUID identifies one immutable monetary intent.  Replay
    // must win before mutable booking-state checks, but it must not silently
    // turn a caller's different amount into success for the stored amount.
    if (
      args.amountCents !== undefined && args.amountCents !== null &&
      args.amountCents !== storedMaterial.amountCents
    ) {
      return { ok: false, status: "not_claimed", operationId, reason: "payment_replay_material_conflict" };
    }
    if (inspectedRow.status === "succeeded") {
      const result = inspectedRow.result && typeof inspectedRow.result === "object"
        ? inspectedRow.result as Record<string, unknown>
        : null;
      const receipt = typeof result?.provider_payment_id === "string"
        ? result.provider_payment_id
        : typeof result?.provider_refund_id === "string"
          ? result.provider_refund_id
          : null;
      return receipt
        ? { ok: true, status: "succeeded", operationId, providerReceipt: receipt }
        : { ok: false, status: "unknown", operationId, reason: "payment_replay_receipt_invalid" };
    }
    if (inspectedRow.status === "failed") {
      return {
        ok: false,
        status: "definite_failure",
        operationId,
        reason: typeof inspectedRow.error_code === "string"
          ? inspectedRow.error_code
          : "operation_failed",
      };
    }
    let reconciled: { data: unknown; error: unknown };
    try {
      reconciled = await args.db.rpc("claim_booking_payment_operation_reconciliation", {
        p_operation_id: operationId,
        p_request_id: args.requestId,
        p_expected_material_fingerprint: fingerprint,
      });
    } catch {
      return { ok: false, status: "unknown", operationId, reason: "payment_reconciliation_unavailable" };
    }
    if (reconciled.error) {
      return { ok: false, status: "unknown", operationId, reason: "payment_reconciliation_unavailable" };
    }
    const reconcileClaim = parseClaimedBookingPaymentOperation(
      reconciled.data,
      args.operationKind,
    );
    if (reconcileClaim) {
      return dispatchClaimedBookingPaymentOperation({
        db: args.db,
        claim: reconcileClaim,
        provider: args.provider,
        note: args.note,
        referenceId: args.referenceId,
        reason: args.reason,
      });
    }
    const reconcileRaw = Array.isArray(reconciled.data) ? reconciled.data[0] : reconciled.data;
    const reconcileRow = reconcileRaw && typeof reconcileRaw === "object"
      ? reconcileRaw as Record<string, unknown>
      : null;
    const reconcileCode = typeof reconcileRow?.code === "string"
      ? reconcileRow.code
      : "reconciliation_required";
    return {
      ok: false,
      status: inspectedRow.status === "pending_provider" ? "pending_provider" : "unknown",
      operationId,
      reason: reconcileCode,
    };
  }
  if (inspectedRow?.success !== false || inspectedRow.code !== "operation_not_found") {
    return {
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: typeof inspectedRow?.code === "string"
        ? inspectedRow.code
        : "payment_inspection_invalid",
    };
  }

  let loaded: { data: unknown; error: unknown };
  try {
    loaded = await args.db.rpc("load_booking_payment_operation_material", {
      p_salon_id: args.salonId,
      p_booking_id: args.bookingId,
      p_operation_kind: args.operationKind,
      p_amount_cents: args.amountCents ?? null,
    });
  } catch {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_material_unavailable" };
  }
  if (loaded.error) {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_material_unavailable" };
  }
  const material = parseBookingPaymentOperationMaterial(loaded.data, args.operationKind);
  if (!material || material.salonId !== args.salonId || material.bookingId !== args.bookingId) {
    const row = Array.isArray(loaded.data) ? loaded.data[0] : loaded.data;
    const reason = row && typeof row === "object" &&
        typeof (row as Record<string, unknown>).code === "string"
      ? String((row as Record<string, unknown>).code)
      : "payment_material_invalid";
    return { ok: false, status: "not_claimed", operationId: null, reason };
  }

  let claimed: { data: unknown; error: unknown };
  try {
    claimed = await args.db.rpc("claim_booking_payment_operation", {
      p_salon_id: args.salonId,
      p_booking_id: args.bookingId,
      p_request_id: args.requestId,
      p_operation_kind: args.operationKind,
      p_amount_cents: material.amountCents,
      p_expected_material_fingerprint: material.materialFingerprint,
    });
  } catch {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_claim_unavailable" };
  }
  if (claimed.error) {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_claim_unavailable" };
  }
  const claim = parseClaimedBookingPaymentOperation(claimed.data, args.operationKind);
  if (claim) {
    return dispatchClaimedBookingPaymentOperation({
      db: args.db,
      claim,
      provider: args.provider,
      note: args.note,
      referenceId: args.referenceId,
      reason: args.reason,
    });
  }
  const claimRow = Array.isArray(claimed.data) ? claimed.data[0] : claimed.data;
  const row = claimRow && typeof claimRow === "object"
    ? claimRow as Record<string, unknown>
    : null;
  const operationId = typeof row?.operation_id === "string" ? row.operation_id : null;
  if (row?.success === true &&
      ["operation_replay", "charge_replay"].includes(String(row.code ?? "")) &&
      row.status === "succeeded" && operationId) {
    const result = row.result && typeof row.result === "object"
      ? row.result as Record<string, unknown>
      : null;
    const providerReceipt = typeof result?.provider_payment_id === "string"
      ? result.provider_payment_id
      : typeof result?.provider_refund_id === "string"
        ? result.provider_refund_id
        : null;
    return providerReceipt
      ? { ok: true, status: "succeeded", operationId, providerReceipt }
      : { ok: false, status: "unknown", operationId, reason: "payment_replay_receipt_invalid" };
  }
  const code = typeof row?.code === "string" ? row.code : "payment_not_claimed";
  if (code === "reconciliation_required") {
    if (!operationId) {
      return { ok: false, status: "not_claimed", operationId: null, reason: "payment_claim_invalid" };
    }
    return {
      ok: false,
      status: row?.status === "pending_provider" ? "pending_provider" : "unknown",
      operationId,
      reason: code,
    };
  }
  return { ok: false, status: "not_claimed", operationId, reason: code };
}

/**
 * Claims and dispatches one immutable Owner/Admin-approved late/group
 * cancellation fee. SQL owns the exact amount, card, tenant provider account,
 * approval receipt and stable request id; the caller supplies no money data.
 */
export async function runApprovedCancellationFeePayment(args: {
  db: RpcClient;
  salonId: string;
  reviewId: string;
  reviewKind: "late" | "group";
  actorUserId: string;
  actorRole: "owner" | "admin";
  provider?: PaymentProvider;
}): Promise<BookingPaymentRunOutcome> {
  let claimed: { data: unknown; error: unknown };
  try {
    claimed = await args.db.rpc("claim_approved_cancellation_fee_payment", {
      p_review_kind: args.reviewKind,
      p_review_id: args.reviewId,
      p_salon_id: args.salonId,
      p_actor_user_id: args.actorUserId,
      p_actor_role: args.actorRole,
    });
  } catch {
    return {
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: "payment_claim_unavailable",
    };
  }
  if (claimed.error) {
    return {
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: "payment_claim_unavailable",
    };
  }
  const claim = parseClaimedBookingPaymentOperation(
    claimed.data,
    "late_cancel_charge",
  );
  if (claim) {
    return dispatchClaimedBookingPaymentOperation({
      db: args.db,
      claim,
      provider: args.provider,
      providerPurpose: "approved_cancellation_fee",
      note: args.reviewKind === "group"
        ? "Approved group cancellation fee"
        : "Approved late cancellation fee",
      referenceId: `booking:${claim.material.bookingId}`,
    });
  }

  const raw = Array.isArray(claimed.data) ? claimed.data[0] : claimed.data;
  const row = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : null;
  const operationId = typeof row?.operation_id === "string"
    ? row.operation_id
    : null;
  const code = typeof row?.code === "string" ? row.code : "payment_not_claimed";
  if (row?.success === true && code === "operation_replay" &&
      row.status === "succeeded" && operationId) {
    const result = row.result && typeof row.result === "object"
      ? row.result as Record<string, unknown>
      : null;
    const receipt = typeof result?.provider_payment_id === "string"
      ? result.provider_payment_id
      : null;
    return receipt
      ? { ok: true, status: "succeeded", operationId, providerReceipt: receipt }
      : {
          ok: false,
          status: "unknown",
          operationId,
          reason: "payment_replay_receipt_invalid",
        };
  }
  if (code === "operation_failed" && operationId) {
    return {
      ok: false,
      status: "definite_failure",
      operationId,
      reason: typeof row?.error_code === "string"
        ? row.error_code
        : "operation_failed",
    };
  }
  if (code === "reconciliation_required" && operationId &&
      typeof row?.material_fingerprint === "string" &&
      typeof row?.request_id === "string") {
    let reconciled: { data: unknown; error: unknown };
    try {
      reconciled = await args.db.rpc(
        "claim_booking_payment_operation_reconciliation",
        {
          p_operation_id: operationId,
          p_request_id: row.request_id,
          p_expected_material_fingerprint: row.material_fingerprint,
        },
      );
    } catch {
      return {
        ok: false,
        status: "unknown",
        operationId,
        reason: "payment_reconciliation_unavailable",
      };
    }
    if (reconciled.error) {
      return {
        ok: false,
        status: "unknown",
        operationId,
        reason: "payment_reconciliation_unavailable",
      };
    }
    const retry = parseClaimedBookingPaymentOperation(
      reconciled.data,
      "late_cancel_charge",
    );
    if (retry) {
      return dispatchClaimedBookingPaymentOperation({
        db: args.db,
        claim: retry,
        provider: args.provider,
        providerPurpose: "approved_cancellation_fee",
        note: args.reviewKind === "group"
          ? "Approved group cancellation fee"
          : "Approved late cancellation fee",
        referenceId: `booking:${retry.material.bookingId}`,
      });
    }
  }
  if (code === "reconciliation_required" && operationId) {
    return { ok: false, status: "unknown", operationId, reason: code };
  }
  return { ok: false, status: "not_claimed", operationId, reason: code };
}

/**
 * Claim and dispatch the exact user-confirmed remaining deposit while the
 * booking is atomically locked in `cancelled`. The dedicated SQL claim checks
 * stable-request replay before mutable booking/refund state, so a lost action
 * response cannot create a second provider refund.
 */
export async function runCancelledBookingRemainingDepositRefund(args: {
  db: RpcClient;
  salonId: string;
  bookingId: string;
  requestId: string;
  expectedRemainingCents: number;
  provider?: PaymentProvider;
}): Promise<BookingPaymentRunOutcome> {
  let claimed: { data: unknown; error: unknown };
  try {
    claimed = await args.db.rpc(
      "claim_cancelled_booking_remaining_deposit_refund",
      {
        p_salon_id: args.salonId,
        p_booking_id: args.bookingId,
        p_request_id: args.requestId,
        p_expected_remaining_cents: args.expectedRemainingCents,
      },
    );
  } catch {
    return {
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: "payment_claim_unavailable",
    };
  }
  if (claimed.error) {
    return {
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: "payment_claim_unavailable",
    };
  }

  const claim = parseClaimedBookingPaymentOperation(
    claimed.data,
    "deposit_refund",
  );
  if (claim) {
    return dispatchClaimedBookingPaymentOperation({
      db: args.db,
      claim,
      provider: args.provider,
      reason: "Booking cancelled — deposit refund",
    });
  }

  const raw = Array.isArray(claimed.data) ? claimed.data[0] : claimed.data;
  const row = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : null;
  const operationId = typeof row?.operation_id === "string"
    ? row.operation_id
    : null;
  const code = typeof row?.code === "string" ? row.code : "payment_not_claimed";
  if (
    row?.success === true && code === "operation_replay" &&
    row.status === "succeeded" && operationId
  ) {
    const result = row.result && typeof row.result === "object"
      ? row.result as Record<string, unknown>
      : null;
    const receipt = typeof result?.provider_refund_id === "string"
      ? result.provider_refund_id
      : null;
    return receipt
      ? {
          ok: true,
          status: "succeeded",
          operationId,
          providerReceipt: receipt,
        }
      : {
          ok: false,
          status: "unknown",
          operationId,
          reason: "payment_replay_receipt_invalid",
        };
  }
  if (code === "operation_failed") {
    if (!operationId) {
      return {
        ok: false,
        status: "not_claimed",
        operationId: null,
        reason: "payment_claim_invalid",
      };
    }
    return {
      ok: false,
      status: "definite_failure",
      operationId,
      reason: typeof row?.error_code === "string"
        ? row.error_code
        : "operation_failed",
    };
  }
  if (["reconciliation_required", "in_flight"].includes(code)) {
    return runAuthoritativeBookingPaymentOperation({
      db: args.db,
      salonId: args.salonId,
      bookingId: args.bookingId,
      requestId: args.requestId,
      operationKind: "deposit_refund",
      amountCents: args.expectedRemainingCents,
      provider: args.provider,
      reason: "Booking cancelled — deposit refund",
    });
  }
  return {
    ok: false,
    status: "not_claimed",
    operationId,
    reason: code,
  };
}

/** Dedicated parent-bound Fair Cancel refund. Generic late-cancel refund claims
 * are intentionally rejected by SQL so no caller can substitute another fee. */
export async function runAuthoritativeLateCancelRefund(args: {
  db: RpcClient;
  parentOperationId: string;
  requestId: string;
  amountCents: number;
  provider?: PaymentProvider;
  reason?: string;
}): Promise<BookingPaymentRunOutcome> {
  let loaded: { data: unknown; error: unknown };
  try {
    loaded = await args.db.rpc("load_late_cancel_refund_material", {
      p_parent_operation_id: args.parentOperationId,
      p_amount_cents: args.amountCents,
    });
  } catch {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_material_unavailable" };
  }
  if (loaded.error) {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_material_unavailable" };
  }
  const loadedRow = Array.isArray(loaded.data) ? loaded.data[0] : loaded.data;
  const row = loadedRow && typeof loadedRow === "object"
    ? loadedRow as Record<string, unknown>
    : null;
  const fingerprint = typeof row?.material_fingerprint === "string"
    ? row.material_fingerprint
    : null;
  const material = fingerprint
    ? parseBookingPaymentOperationMaterial(
        {
          ...(row?.material as Record<string, unknown> | null ?? {}),
          material_fingerprint: fingerprint,
        },
        "late_cancel_refund",
      )
    : null;
  if (!material || material.parentOperationId !== args.parentOperationId) {
    return {
      ok: false,
      status: "not_claimed",
      operationId: null,
      reason: typeof row?.code === "string" ? row.code : "payment_material_invalid",
    };
  }

  let claimed: { data: unknown; error: unknown };
  try {
    claimed = await args.db.rpc("claim_late_cancel_refund", {
      p_parent_operation_id: args.parentOperationId,
      p_request_id: args.requestId,
      p_amount_cents: material.amountCents,
      p_expected_material_fingerprint: material.materialFingerprint,
    });
  } catch {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_claim_unavailable" };
  }
  if (claimed.error) {
    return { ok: false, status: "not_claimed", operationId: null, reason: "payment_claim_unavailable" };
  }
  const claim = parseClaimedBookingPaymentOperation(claimed.data, "late_cancel_refund");
  if (claim) {
    return dispatchClaimedBookingPaymentOperation({
      db: args.db,
      claim,
      provider: args.provider,
      reason: args.reason ?? "Late cancellation fee refunded — slot rebooked",
    });
  }
  const raw = Array.isArray(claimed.data) ? claimed.data[0] : claimed.data;
  const claimRow = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const operationId = typeof claimRow?.operation_id === "string"
    ? claimRow.operation_id
    : null;
  if (
    claimRow?.success === true && claimRow.code === "operation_replay" &&
    claimRow.status === "succeeded" && operationId
  ) {
    const result = claimRow.result && typeof claimRow.result === "object"
      ? claimRow.result as Record<string, unknown>
      : null;
    const receipt = typeof result?.provider_refund_id === "string"
      ? result.provider_refund_id
      : null;
    return receipt
      ? { ok: true, status: "succeeded", operationId, providerReceipt: receipt }
      : { ok: false, status: "unknown", operationId, reason: "payment_replay_receipt_invalid" };
  }
  const code = typeof claimRow?.code === "string" ? claimRow.code : "payment_not_claimed";
  if (code === "reconciliation_required" && operationId) {
    return { ok: false, status: "unknown", operationId, reason: code };
  }
  return {
    ok: false,
    status: "not_claimed",
    operationId,
    reason: code,
  };
}
