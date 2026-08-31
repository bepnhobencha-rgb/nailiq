import { createHash } from "node:crypto";

import type { SmartCheckoutProviderReceipt } from "@/shared/checkout/smartCheckoutAdapter";
import type {
  SmartCheckoutProvider,
  SmartCheckoutStatus,
} from "@/shared/checkout/smartCheckout";

export type SmartCheckoutReconciliationClaim = {
  sessionId: string;
  salonId: string;
  provider: SmartCheckoutProvider;
  providerAccountFingerprint: string;
  providerLocationId: string | null;
  providerDeviceId: string | null;
  providerCheckoutId: string | null;
  amountCents: number;
  currency: string;
  attemptToken: string;
};

export type SmartCheckoutReconciliationReceipt = {
  provider: SmartCheckoutProvider;
  providerAccountFingerprint: string;
  providerLocationId: string | null;
  providerDeviceId: string | null;
  checkoutId: string;
  paymentId: string | null;
  providerStatus: string;
  status: Extract<
    SmartCheckoutStatus,
    | "awaiting_customer"
    | "pending_provider"
    | "outcome_unknown"
    | "paid"
    | "failed"
    | "cancelled"
  >;
  amountCents: number | null;
  currency: string | null;
  occurredAt: string | null;
};

export type SmartCheckoutReconciliationDecision =
  | {
      ok: true;
      disposition: "resolved" | "retry";
      status: SmartCheckoutReconciliationReceipt["status"];
      receipt: SmartCheckoutReconciliationReceipt;
    }
  | {
      ok: false;
      disposition: "manual_review";
      code:
        | "provider_context_mismatch"
        | "provider_checkout_mismatch"
        | "provider_device_mismatch"
        | "provider_location_mismatch"
        | "receipt_amount_mismatch"
        | "receipt_currency_mismatch"
        | "paid_receipt_incomplete";
    };

const HASH_RE = /^[0-9a-f]{64}$/u;

export function fingerprintSmartCheckoutProviderAccount(
  provider: SmartCheckoutProvider,
  providerAccountId: string,
): string | null {
  const normalized = providerAccountId.trim();
  if (!/^[!-~]{1,255}$/u.test(normalized)) return null;
  return createHash("sha256")
    .update(`${provider}:${normalized}`, "utf8")
    .digest("hex");
}

/**
 * Convert a provider adapter read into the evidence shape accepted by the
 * truth decision. A receipt that does not name its account is deliberately
 * assigned an invalid fingerprint and will fail closed to manual review.
 */
export function reconciliationReceiptFromProvider(
  receipt: SmartCheckoutProviderReceipt,
): SmartCheckoutReconciliationReceipt {
  const accountFingerprint = receipt.evidence.providerAccountId
    ? fingerprintSmartCheckoutProviderAccount(
        receipt.provider,
        receipt.evidence.providerAccountId,
      )
    : null;
  return {
    provider: receipt.provider,
    providerAccountFingerprint: accountFingerprint ?? "",
    providerLocationId: receipt.evidence.providerLocationId,
    providerDeviceId: receipt.evidence.providerDeviceId,
    checkoutId: receipt.checkoutId,
    paymentId: receipt.paymentId,
    providerStatus: receipt.providerStatus,
    status: receipt.status,
    amountCents: receipt.evidence.amountCents,
    currency: receipt.evidence.currency,
    occurredAt: receipt.evidence.occurredAt,
  };
}

/**
 * Verify a normalized provider read against the immutable checkout material.
 * This function never performs or retries a charge. Any identity or exact-
 * amount disagreement enters human review instead of guessing which receipt
 * belongs to the salon.
 */
export function decideSmartCheckoutReconciliation(
  claim: SmartCheckoutReconciliationClaim,
  receipt: SmartCheckoutReconciliationReceipt,
): SmartCheckoutReconciliationDecision {
  if (
    receipt.provider !== claim.provider ||
    !HASH_RE.test(receipt.providerAccountFingerprint) ||
    receipt.providerAccountFingerprint !== claim.providerAccountFingerprint
  ) {
    return { ok: false, disposition: "manual_review", code: "provider_context_mismatch" };
  }
  if (claim.providerCheckoutId && receipt.checkoutId !== claim.providerCheckoutId) {
    return { ok: false, disposition: "manual_review", code: "provider_checkout_mismatch" };
  }
  if (
    claim.providerLocationId !== null &&
    receipt.providerLocationId !== claim.providerLocationId
  ) {
    return { ok: false, disposition: "manual_review", code: "provider_location_mismatch" };
  }
  if (
    claim.providerDeviceId !== null &&
    receipt.providerDeviceId !== claim.providerDeviceId
  ) {
    return { ok: false, disposition: "manual_review", code: "provider_device_mismatch" };
  }

  if (receipt.status === "paid") {
    if (
      !receipt.paymentId ||
      !receipt.checkoutId ||
      !receipt.occurredAt ||
      !Number.isFinite(Date.parse(receipt.occurredAt))
    ) {
      return { ok: false, disposition: "manual_review", code: "paid_receipt_incomplete" };
    }
    if (receipt.amountCents !== claim.amountCents) {
      return { ok: false, disposition: "manual_review", code: "receipt_amount_mismatch" };
    }
    if (receipt.currency?.trim().toUpperCase() !== claim.currency.trim().toUpperCase()) {
      return { ok: false, disposition: "manual_review", code: "receipt_currency_mismatch" };
    }
  }

  return {
    ok: true,
    disposition:
      receipt.status === "awaiting_customer" ||
      receipt.status === "pending_provider" ||
      receipt.status === "outcome_unknown"
        ? "retry"
        : "resolved",
    status: receipt.status,
    receipt,
  };
}
