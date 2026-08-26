/** Authoritative Square hosted deposit links backed by the payment ledger. */
import "server-only";
import { createHash } from "node:crypto";
import { getSquareConfig, createPaymentLink, getOrder } from "./client";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { runAuthoritativeBookingPaymentOperation } from "@/shared/payments/executeBookingPaymentOperation";
import { v1AllowsCustomerPaymentGateway } from "@/shared/release/v1IntegrationScope";

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface DepositResult {
  required: boolean;
  reason: string;
  url?: string;
  amountCents?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

type HostedLinkClaim = {
  operationId: string;
  bookingId: string;
  salonId: string;
  attemptToken: string;
  providerIdempotencyKey: string;
  materialFingerprint: string;
  amountCents: number;
  currency: string;
  hold: boolean;
  providerAccountId: string;
  providerLocationId: string;
  providerEnvironment: "sandbox" | "production";
};

function parseHostedLinkClaim(value: unknown): HostedLinkClaim | null {
  const row = record(value);
  if (
    row?.success !== true ||
    !["link_claimed", "link_attempt_replay", "reconcile_claimed"].includes(String(row.code ?? "")) ||
    !["sending", "reconciling"].includes(String(row.status ?? ""))
  ) return null;
  const operationId = str(row.operation_id);
  const bookingId = str(row.booking_id);
  const attemptToken = str(row.attempt_token);
  const providerIdempotencyKey = str(row.provider_idempotency_key);
  const materialFingerprint = str(row.material_fingerprint);
  const material = record(row.material);
  const providerMaterial = record(row.provider_material);
  const salonId = str(material?.salon_id);
  const amountCents = num(material?.amount_cents);
  const currency = str(material?.currency).toUpperCase();
  const accountId = str(providerMaterial?.provider_account_id);
  const locationId = str(providerMaterial?.provider_location_id);
  const environment = providerMaterial?.provider_environment === "sandbox" ||
      providerMaterial?.provider_environment === "production"
    ? providerMaterial.provider_environment
    : null;
  const accountFingerprint = str(material?.provider_account_fingerprint);
  if (
    !UUID_RE.test(operationId) || !UUID_RE.test(bookingId) || !UUID_RE.test(salonId) ||
    !UUID_RE.test(attemptToken) || providerIdempotencyKey !== `nq:${operationId}` ||
    !HASH_RE.test(materialFingerprint) || material?.booking_id !== bookingId ||
    material?.operation_kind !== "deposit_charge" ||
    material?.delivery_mode !== "square_hosted_link" || material?.provider !== "square" ||
    !Number.isSafeInteger(amountCents) || amountCents <= 0 || !/^[A-Z]{3}$/.test(currency) ||
    typeof material?.hold !== "boolean" || !accountId || !locationId || !environment ||
    providerMaterial?.amount_cents !== amountCents ||
    providerMaterial?.booking_reference !== bookingId ||
    providerMaterial?.delivery_mode !== "square_hosted_link" ||
    providerMaterial?.currency !== currency ||
    accountFingerprint !== createHash("sha256")
      .update(`square:${accountId}:${locationId}:${environment}`, "utf8").digest("hex")
  ) return null;
  return {
    operationId,
    bookingId,
    salonId,
    attemptToken,
    providerIdempotencyKey,
    materialFingerprint,
    amountCents,
    currency,
    hold: material.hold,
    providerAccountId: accountId,
    providerLocationId: locationId,
    providerEnvironment: environment,
  };
}

function stableHostedLinkRequestId(bookingId: string): string {
  const bytes = Buffer.from(createHash("sha256")
    .update(`nailiq:hosted-deposit-link:v1:${bookingId}`, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createDepositForBooking(
  bookingId: string,
  opts?: { manual?: boolean; hold?: boolean; requestId?: string },
): Promise<DepositResult> {
  if (!v1AllowsCustomerPaymentGateway()) {
    return { required: false, reason: "phase_2_not_available" };
  }
  if (!UUID_RE.test(bookingId)) return { required: false, reason: "invalid booking" };
  const requestId = opts?.requestId ?? stableHostedLinkRequestId(bookingId);
  if (!UUID_RE.test(requestId)) return { required: false, reason: "invalid request" };
  const db = createServiceRoleClient();
  const { data: booking, error: bookingError } = await db
    .from("bookings")
    .select("id, salon_id, client_name")
    .eq("id", bookingId)
    .maybeSingle();
  const bookingRow = booking as { id?: string; salon_id?: string; client_name?: string | null } | null;
  if (bookingError || bookingRow?.id !== bookingId || !UUID_RE.test(str(bookingRow.salon_id))) {
    return { required: false, reason: "booking not found" };
  }
  const salonId = str(bookingRow.salon_id);
  const claimed = await db.rpc("claim_booking_square_deposit_link" as never, {
    p_salon_id: salonId,
    p_booking_id: bookingId,
    p_request_id: requestId,
    p_hold: opts?.hold === true,
  } as never);
  if (claimed.error) throw new Error("deposit_link_claim_unavailable");
  const row = record(claimed.data);
  if (
    row?.success === true &&
    ["link_ready", "link_payment_replay"].includes(String(row.code ?? ""))
  ) {
    const url = str(row.link_url);
    const amountCents = num(record(row.material)?.amount_cents ?? record(row.result)?.amount_cents);
    if (!url.startsWith("https://") || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error("deposit_link_receipt_invalid");
    }
    return { required: true, reason: "existing link", url, amountCents };
  }
  const claim = parseHostedLinkClaim(claimed.data);
  if (!claim || claim.bookingId !== bookingId || claim.salonId !== salonId) {
    const code = str(row?.code);
    if (["booking_not_deposit_eligible", "square_deposits_disabled"].includes(code)) {
      return { required: false, reason: code };
    }
    throw new Error(code || "deposit_link_claim_invalid");
  }
  const cfg = await getSquareConfig(db as never, salonId);
  if (
    cfg.merchantId !== claim.providerAccountId || cfg.locationId !== claim.providerLocationId ||
    cfg.environment !== claim.providerEnvironment || cfg.currency !== claim.currency
  ) throw new Error("square_provider_account_mismatch");
  const link = await createPaymentLink(cfg, {
    amountCents: claim.amountCents,
    name: `Deposit — ${str(bookingRow.client_name) || "appointment"}`,
    referenceId: bookingId,
    idempotencyKey: claim.providerIdempotencyKey,
    note: `NailIQ deposit for booking ${bookingId}`,
  });
  if (!link.orderId) throw new Error("square_link_order_missing");
  const attached = await db.rpc("attach_booking_square_deposit_link" as never, {
    p_operation_id: claim.operationId,
    p_attempt_token: claim.attemptToken,
    p_square_link_id: link.id,
    p_square_order_id: link.orderId,
    p_link_url: link.url,
  } as never);
  const attachedRow = record(attached.data);
  if (
    attached.error || attachedRow?.success !== true ||
    !["link_attached", "link_attach_replay"].includes(String(attachedRow.code ?? "")) ||
    attachedRow.operation_id !== claim.operationId || attachedRow.booking_id !== bookingId ||
    attachedRow.provider_link_id !== link.id || attachedRow.provider_order_id !== link.orderId ||
    attachedRow.link_url !== link.url || attachedRow.material_fingerprint !== claim.materialFingerprint
  ) throw new Error("deposit_link_attach_unavailable");
  return {
    required: true,
    reason: "deposit link created",
    url: link.url,
    amountCents: claim.amountCents,
  };
}

/**
 * Refund a paid Square deposit (mutually-agreed cancel). Returns ok:false with a
 * reason the desk can surface (e.g. refund manually in Square) rather than throwing.
 */
export async function refundDeposit(
  bookingId: string,
  options: { amountCents?: number; requestId: string },
): Promise<{ ok: boolean; reason: string; refundedCents?: number; remainingCents?: number }> {
  if (!v1AllowsCustomerPaymentGateway()) {
    return { ok: false, reason: "phase_2_not_available" };
  }
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("bookings")
    .select("id, salon_id, deposit_amount_cents, deposit_refunded_cents")
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as {
    id?: string;
    salon_id?: string;
    deposit_amount_cents?: number | null;
    deposit_refunded_cents?: number | null;
  } | null;
  if (error || !b?.id || !b.salon_id) {
    return { ok: false, reason: "payment context unavailable" };
  }
  const captured = Number(b.deposit_amount_cents);
  const refunded = Number(b.deposit_refunded_cents ?? 0);
  const remaining = captured - refunded;
  const amountCents = options?.amountCents ?? remaining;
  if (
    !Number.isSafeInteger(captured) || !Number.isSafeInteger(refunded) ||
    !Number.isSafeInteger(amountCents) || captured <= 0 || refunded < 0 ||
    remaining <= 0 || amountCents <= 0 || amountCents > remaining
  ) return { ok: false, reason: "invalid refund amount" };
  const outcome = await runAuthoritativeBookingPaymentOperation({
    db: db as never,
    salonId: b.salon_id,
    bookingId,
    requestId: options.requestId,
    operationKind: "deposit_refund",
    amountCents,
    reason: "Booking cancelled — deposit refund",
  });
  if (!outcome.ok) {
    return { ok: false, reason: `${outcome.status}:${outcome.reason}` };
  }
  const { data: refreshed, error: refreshedError } = await db
    .from("bookings")
    .select("deposit_refunded_cents")
    .eq("salon_id", b.salon_id)
    .eq("id", bookingId)
    .maybeSingle();
  const refundedCents = Number(
    (refreshed as { deposit_refunded_cents?: unknown } | null)?.deposit_refunded_cents,
  );
  if (refreshedError || !Number.isSafeInteger(refundedCents) || refundedCents < 1) {
    return { ok: false, reason: "refund receipt unavailable" };
  }
  return {
    ok: true,
    reason: "refunded",
    refundedCents,
    remainingCents: Math.max(0, captured - refundedCents),
  };
}

export async function reconcileSquareHostedDepositClaim(
  db: ReturnType<typeof createServiceRoleClient>,
  value: unknown,
): Promise<"succeeded" | "unresolved"> {
  if (!v1AllowsCustomerPaymentGateway()) return "unresolved";
  const result = await reconcileSquareHostedDepositClaimHealth(db, value);
  return result.status === "succeeded" ? "succeeded" : "unresolved";
}

type HostedDepositReconciliationHealth =
  | { ok: true; status: "succeeded" | "pending_provider" }
  | { ok: false; status: "unhealthy"; error: string };

async function reconcileSquareHostedDepositClaimHealth(
  db: ReturnType<typeof createServiceRoleClient>,
  value: unknown,
): Promise<HostedDepositReconciliationHealth> {
  const row = record(value);
  const claim = parseHostedLinkClaim(value);
  const orderId = str(row?.provider_order_id);
  const linkId = str(row?.provider_link_id);
  const linkUrl = str(row?.provider_link_url);
  if (!claim || !orderId || !linkId || !linkUrl.startsWith("https://")) {
    return {
      ok: false,
      status: "unhealthy",
      error: "square_deposit_reconciliation_claim_invalid",
    };
  }
  let order: Awaited<ReturnType<typeof getOrder>>;
  try {
    const cfg = await getSquareConfig(db as never, claim.salonId);
    if (
      cfg.merchantId !== claim.providerAccountId || cfg.locationId !== claim.providerLocationId ||
      cfg.environment !== claim.providerEnvironment || cfg.currency !== claim.currency
    ) {
      return {
        ok: false,
        status: "unhealthy",
        error: "square_deposit_reconciliation_context_mismatch",
      };
    }
    order = await getOrder(cfg, orderId);
  } catch {
    return {
      ok: false,
      status: "unhealthy",
      error: "square_deposit_reconciliation_provider_unavailable",
    };
  }
  const completed = order.state === "COMPLETED" &&
    order.paidCents >= claim.amountCents && Boolean(order.tenderPaymentId);
  const pending = ["OPEN", "PENDING", "APPROVED"].includes(order.state.toUpperCase());
  const failed = ["CANCELED", "CANCELLED", "FAILED", "REJECTED"].includes(
    order.state.toUpperCase(),
  );
  const outcome = completed
    ? "succeeded"
    : pending ? "pending_provider" : failed ? "definite_failure" : "unknown";
  try {
    const result = await db.rpc("complete_booking_payment_operation" as never, {
      p_operation_id: claim.operationId,
      p_attempt_token: claim.attemptToken,
      p_outcome: outcome,
      p_provider_status: order.state,
      p_provider_payment_id: order.tenderPaymentId,
      p_provider_refund_id: null,
      p_error_code: failed ? "provider_rejected" : outcome === "unknown"
        ? "provider_outcome_ambiguous" : null,
    } as never);
    const completedRow = record(result.data);
    const expectedStatus = completed
      ? "succeeded"
      : pending ? "pending_provider" : failed ? "failed" : "unknown";
    const completionPersisted = !result.error
      && completedRow?.status === expectedStatus
      && (completed || pending
        ? completedRow.success === true
        : completedRow.success === false);
    if (!completionPersisted) {
      return {
        ok: false,
        status: "unhealthy",
        error: "square_deposit_reconciliation_completion_unavailable",
      };
    }
    if (completed) return { ok: true, status: "succeeded" };
    if (pending) return { ok: true, status: "pending_provider" };
    return {
      ok: false,
      status: "unhealthy",
      error: failed
        ? "square_deposit_reconciliation_provider_rejected"
        : "square_deposit_reconciliation_provider_response_invalid",
    };
  } catch {
    return {
      ok: false,
      status: "unhealthy",
      error: "square_deposit_reconciliation_completion_unavailable",
    };
  }
}

/** Reconcile only ledger-owned hosted links; booking financial truth is updated
 * atomically by complete_booking_payment_operation. */
export async function reconcileDeposits(
  salonId: string,
): Promise<{ ok: boolean; checked: number; paid: number; error?: string }> {
  if (!v1AllowsCustomerPaymentGateway()) {
    return { ok: false, checked: 0, paid: 0, error: "phase_2_not_available" };
  }
  if (!UUID_RE.test(salonId)) {
    return {
      ok: false,
      checked: 0,
      paid: 0,
      error: "square_deposit_reconciliation_input_invalid",
    };
  }
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("booking_payment_operations" as never)
    .select("id, request_id, material_fingerprint" as never)
    .eq("salon_id", salonId)
    .eq("operation_kind", "deposit_charge")
    .eq("delivery_mode", "square_hosted_link")
    .in("status", ["pending_provider", "unknown"])
    .limit(100);
  if (error || !Array.isArray(data)) {
    return {
      ok: false,
      checked: 0,
      paid: 0,
      error: "square_deposit_reconciliation_inventory_unavailable",
    };
  }
  let paid = 0;
  for (const value of data) {
    const row = value as unknown as Record<string, unknown>;
    const operationId = str(row.id);
    const requestId = str(row.request_id);
    const fingerprint = str(row.material_fingerprint);
    if (!UUID_RE.test(operationId) || !UUID_RE.test(requestId) || !HASH_RE.test(fingerprint)) {
      return {
        ok: false,
        checked: data.length,
        paid,
        error: "square_deposit_reconciliation_inventory_invalid",
      };
    }
    try {
      const claimed = await db.rpc("claim_booking_payment_operation_reconciliation" as never, {
        p_operation_id: operationId,
        p_request_id: requestId,
        p_expected_material_fingerprint: fingerprint,
      } as never);
      if (claimed.error) {
        return {
          ok: false,
          checked: data.length,
          paid,
          error: "square_deposit_reconciliation_claim_unavailable",
        };
      }
      const reconciliation = await reconcileSquareHostedDepositClaimHealth(db, claimed.data);
      if (!reconciliation.ok) {
        return {
          ok: false,
          checked: data.length,
          paid,
          error: reconciliation.error,
        };
      }
      if (reconciliation.status === "succeeded") paid += 1;
    } catch {
      return {
        ok: false,
        checked: data.length,
        paid,
        error: "square_deposit_reconciliation_unavailable",
      };
    }
  }
  return { ok: true, checked: data.length, paid };
}
