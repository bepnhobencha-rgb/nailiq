import "server-only";

import { createHash } from "node:crypto";

import type { SmartCheckoutAdapter } from "@/shared/checkout/smartCheckoutAdapter";
import {
  decideSmartCheckoutReconciliation,
  fingerprintSmartCheckoutProviderAccount,
  reconciliationReceiptFromProvider,
  type SmartCheckoutReconciliationClaim,
  type SmartCheckoutReconciliationReceipt,
} from "@/shared/checkout/smartCheckoutReconciliation";

type Db = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{
    data: unknown;
    error: unknown;
  }>;
};

type ClaimedSession = SmartCheckoutReconciliationClaim & {
  deviceId: string | null;
  attemptCount: number;
  providerStatus: string | null;
};

export type SmartCheckoutReconciliationContext = {
  adapter: SmartCheckoutAdapter;
  providerAccountId: string;
};

export type SmartCheckoutReconciliationWorkerDeps = {
  db: Db;
  workerId: string;
  gate: {
    environment: "sandbox" | "production";
    reconciliationEnabled: boolean;
  };
  resolveContext: (
    claim: ClaimedSession,
  ) => Promise<SmartCheckoutReconciliationContext | null>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_RE = /^[0-9a-f]{64}$/u;
const CURRENCY_RE = /^[A-Z]{3}$/u;

function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseClaim(value: unknown): ClaimedSession | null {
  const item = row(value);
  const sessionId = nullableString(item?.session_id);
  const salonId = nullableString(item?.salon_id);
  const attemptToken = nullableString(item?.attempt_token);
  const deviceId = nullableString(item?.device_id);
  const providerDeviceId = nullableString(item?.provider_device_id);
  const providerCheckoutId = nullableString(item?.provider_checkout_id);
  const providerStatus = nullableString(item?.provider_status);
  const providerAccountFingerprint = nullableString(item?.provider_account_fingerprint);
  const providerLocationId = nullableString(item?.provider_location_id);
  const amountCents = item?.amount_cents;
  const currency = nullableString(item?.currency)?.toUpperCase() ?? null;
  const attemptCount = item?.attempt_count;
  const provider = item?.provider === "square" || item?.provider === "stripe"
    ? item.provider
    : null;
  if (
    !sessionId || !UUID_RE.test(sessionId) || !salonId || !UUID_RE.test(salonId)
    || !attemptToken || !UUID_RE.test(attemptToken) || !provider
    || !providerAccountFingerprint || !HASH_RE.test(providerAccountFingerprint)
    || (deviceId !== null && !UUID_RE.test(deviceId))
    || !Number.isSafeInteger(amountCents) || (amountCents as number) <= 0
    || !currency || !CURRENCY_RE.test(currency)
    || !Number.isSafeInteger(attemptCount) || (attemptCount as number) < 1
  ) return null;
  return {
    sessionId,
    salonId,
    provider,
    providerAccountFingerprint,
    providerLocationId,
    providerDeviceId,
    providerCheckoutId,
    amountCents: amountCents as number,
    currency,
    attemptToken,
    deviceId,
    attemptCount: attemptCount as number,
    providerStatus,
  };
}

function receiptFingerprint(receipt: SmartCheckoutReconciliationReceipt): string {
  return createHash("sha256").update(JSON.stringify({
    provider: receipt.provider,
    account: receipt.providerAccountFingerprint,
    location: receipt.providerLocationId,
    device: receipt.providerDeviceId,
    checkout: receipt.checkoutId,
    payment: receipt.paymentId,
    status: receipt.providerStatus,
    amount: receipt.amountCents,
    currency: receipt.currency,
    occurred_at: receipt.occurredAt,
  })).digest("hex");
}

async function complete(
  db: Db,
  claim: ClaimedSession,
  input: {
    outcome: "paid" | "retry" | "failed" | "cancelled" | "manual_review";
    receipt: SmartCheckoutReconciliationReceipt | null;
    failureCode: string | null;
  },
): Promise<boolean> {
  const receipt = input.receipt;
  const result = await db.rpc("complete_smart_checkout_reconciliation", {
    p_session_id: claim.sessionId,
    p_attempt_token: claim.attemptToken,
    p_outcome: input.outcome,
    p_provider_account_fingerprint:
      receipt?.providerAccountFingerprint || claim.providerAccountFingerprint,
    p_provider_location_id: receipt?.providerLocationId ?? claim.providerLocationId,
    p_device_id: claim.deviceId,
    p_provider_device_id: receipt?.providerDeviceId ?? claim.providerDeviceId,
    p_provider_checkout_id: receipt?.checkoutId ?? claim.providerCheckoutId,
    p_provider_payment_id: receipt?.paymentId ?? null,
    p_provider_status: receipt?.providerStatus ?? claim.providerStatus ?? "unknown",
    p_amount_cents: receipt?.amountCents ?? claim.amountCents,
    p_currency: receipt?.currency ?? claim.currency,
    p_receipt_id: input.outcome === "paid" && receipt
      ? receipt.paymentId ?? receipt.checkoutId
      : null,
    p_receipt_fingerprint: input.outcome === "paid" && receipt
      ? receiptFingerprint(receipt)
      : null,
    p_paid_at: input.outcome === "paid" ? receipt?.occurredAt ?? null : null,
    p_webhook_event_id: null,
    p_failure_code: input.failureCode,
  });
  const resultRow = row(result.data);
  const code = typeof resultRow?.code === "string" ? resultRow.code : "";
  return !result.error && (
    resultRow?.success === true
    || (input.outcome === "manual_review" && [
      "provider_manual_review",
      "provider_binding_mismatch",
    ].includes(code))
  );
}

/**
 * Claims leases and reads the exact existing provider checkout. It has no
 * dispatch path: response loss can only produce another read, never a charge.
 */
export async function reconcileSmartCheckoutSessions(
  deps: SmartCheckoutReconciliationWorkerDeps,
  limit = 10,
): Promise<{
  ok: boolean;
  processed: number;
  paid: number;
  retried: number;
  manualReview: number;
  terminal: number;
  errors: number;
  code?: "disabled";
}> {
  if (
    deps.gate.environment !== "sandbox"
    || deps.gate.reconciliationEnabled !== true
  ) {
    return {
      ok: true,
      code: "disabled",
      processed: 0,
      paid: 0,
      retried: 0,
      manualReview: 0,
      terminal: 0,
      errors: 0,
    };
  }
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 0), 25);
  const claimed = await deps.db.rpc("claim_due_smart_checkout_reconciliations", {
    p_worker_id: deps.workerId,
    p_limit: boundedLimit,
    p_lease_seconds: 120,
  });
  if (claimed.error || !Array.isArray(claimed.data)) {
    return { ok: false, processed: 0, paid: 0, retried: 0, manualReview: 0, terminal: 0, errors: 1 };
  }

  let processed = 0;
  let paid = 0;
  let retried = 0;
  let manualReview = 0;
  let terminal = 0;
  let errors = 0;

  for (const raw of claimed.data) {
    const claim = parseClaim(raw);
    if (!claim) {
      errors += 1;
      continue;
    }
    processed += 1;

    let context: SmartCheckoutReconciliationContext | null = null;
    try {
      context = await deps.resolveContext(claim);
    } catch {
      context = null;
    }
    const currentFingerprint = context
      ? fingerprintSmartCheckoutProviderAccount(claim.provider, context.providerAccountId)
      : null;
    if (
      !context || context.adapter.provider !== claim.provider
      || currentFingerprint !== claim.providerAccountFingerprint
      || !claim.providerCheckoutId
    ) {
      if (await complete(deps.db, claim, {
        outcome: "manual_review",
        receipt: null,
        failureCode: "provider_context_mismatch",
      })) manualReview += 1;
      else errors += 1;
      continue;
    }

    let receipt: SmartCheckoutReconciliationReceipt;
    try {
      receipt = reconciliationReceiptFromProvider(
        await context.adapter.retrieveCheckout({
          checkoutId: claim.providerCheckoutId,
          providerAccountId: context.providerAccountId,
          providerLocationId: claim.providerLocationId,
        }),
      );
    } catch {
      if (await complete(deps.db, claim, {
        outcome: "retry",
        receipt: null,
        failureCode: "provider_transport_error",
      })) retried += 1;
      else errors += 1;
      continue;
    }

    const decision = decideSmartCheckoutReconciliation(claim, receipt);
    if (!decision.ok) {
      if (await complete(deps.db, claim, {
        outcome: "manual_review",
        receipt,
        failureCode: decision.code,
      })) manualReview += 1;
      else errors += 1;
      continue;
    }
    const outcome = decision.disposition === "retry"
      ? "retry"
      : decision.status === "paid"
        ? "paid"
        : decision.status === "cancelled"
          ? "cancelled"
          : "failed";
    if (!await complete(deps.db, claim, {
      outcome,
      receipt,
      failureCode: outcome === "failed" ? "provider_definite_failure" : null,
    })) {
      errors += 1;
    } else if (outcome === "paid") paid += 1;
    else if (outcome === "retry") retried += 1;
    else terminal += 1;
  }
  return {
    ok: errors === 0,
    processed,
    paid,
    retried,
    manualReview,
    terminal,
    errors,
  };
}
