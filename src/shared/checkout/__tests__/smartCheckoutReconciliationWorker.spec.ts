import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SmartCheckoutAdapter } from "@/shared/checkout/smartCheckoutAdapter";
import { fingerprintSmartCheckoutProviderAccount } from "@/shared/checkout/smartCheckoutReconciliation";
import { reconcileSmartCheckoutSessions } from "@/shared/checkout/smartCheckoutReconciliationWorker";

const accountId = "acct_qa";
const accountFingerprint = fingerprintSmartCheckoutProviderAccount("stripe", accountId)!;
const claim = {
  session_id: "11111111-1111-4111-8111-111111111111",
  salon_id: "22222222-2222-4222-8222-222222222222",
  provider: "stripe",
  provider_account_fingerprint: accountFingerprint,
  provider_location_id: "tml_qa",
  device_id: "33333333-3333-4333-8333-333333333333",
  provider_device_id: "tmr_qa",
  provider_checkout_id: "pi_qa",
  amount_cents: 5350,
  currency: "USD",
  attempt_token: "44444444-4444-4444-8444-444444444444",
  attempt_count: 1,
};

function adapter(overrides: Partial<SmartCheckoutAdapter> = {}): SmartCheckoutAdapter {
  return {
    provider: "stripe",
    createCheckout: vi.fn(),
    cancelCheckout: vi.fn(),
    retrieveCheckout: vi.fn(async () => ({
      provider: "stripe" as const,
      checkoutId: "pi_qa",
      paymentId: "ch_qa",
      providerStatus: "succeeded",
      status: "paid" as const,
      evidence: {
        amountCents: 5350,
        currency: "USD",
        providerAccountId: accountId,
        providerLocationId: "tml_qa",
        providerDeviceId: "tmr_qa",
        occurredAt: "2026-08-31T17:00:00Z",
      },
    })),
    ...overrides,
  };
}

function harness(claims: unknown[] = [claim]) {
  const rpc = vi.fn(async (name: string) => name === "claim_due_smart_checkout_reconciliations"
    ? { data: claims, error: null }
    : { data: { success: true, code: "ok" }, error: null });
  const currentAdapter = adapter();
  const resolveContext = vi.fn(async () => ({ adapter: currentAdapter, providerAccountId: accountId }));
  return { rpc, currentAdapter, resolveContext };
}

describe("Smart Checkout reconciliation worker", () => {
  beforeEach(() => vi.clearAllMocks());

  const gate = { environment: "sandbox", reconciliationEnabled: true } as const;

  it("marks paid only after one exact read of the existing checkout", async () => {
    const h = harness();
    await expect(reconcileSmartCheckoutSessions({
      db: { rpc: h.rpc }, workerId: "qa-worker", gate, resolveContext: h.resolveContext,
    })).resolves.toMatchObject({ ok: true, processed: 1, paid: 1, errors: 0 });
    expect(h.currentAdapter.retrieveCheckout).toHaveBeenCalledTimes(1);
    expect(h.currentAdapter.createCheckout).not.toHaveBeenCalled();
    expect(h.rpc).toHaveBeenLastCalledWith(
      "complete_smart_checkout_reconciliation",
      expect.objectContaining({
        p_outcome: "paid",
        p_provider_checkout_id: "pi_qa",
        p_provider_payment_id: "ch_qa",
        p_amount_cents: 5350,
        p_currency: "USD",
        p_paid_at: "2026-08-31T17:00:00Z",
      }),
    );
  });

  it("moves account drift to manual review before any provider read", async () => {
    const h = harness();
    h.resolveContext.mockResolvedValueOnce({
      adapter: h.currentAdapter,
      providerAccountId: "acct_other",
    });
    await expect(reconcileSmartCheckoutSessions({
      db: { rpc: h.rpc }, workerId: "qa-worker", gate, resolveContext: h.resolveContext,
    })).resolves.toMatchObject({ manualReview: 1 });
    expect(h.currentAdapter.retrieveCheckout).not.toHaveBeenCalled();
    expect(h.currentAdapter.createCheckout).not.toHaveBeenCalled();
  });

  it("sends an amount mismatch to manual review, never paid", async () => {
    const h = harness();
    vi.mocked(h.currentAdapter.retrieveCheckout).mockResolvedValueOnce({
      provider: "stripe",
      checkoutId: "pi_qa",
      paymentId: "ch_qa",
      providerStatus: "succeeded",
      status: "paid",
      evidence: {
        amountCents: 5349,
        currency: "USD",
        providerAccountId: accountId,
        providerLocationId: "tml_qa",
        providerDeviceId: "tmr_qa",
        occurredAt: "2026-08-31T17:00:00Z",
      },
    });
    await expect(reconcileSmartCheckoutSessions({
      db: { rpc: h.rpc }, workerId: "qa-worker", gate, resolveContext: h.resolveContext,
    })).resolves.toMatchObject({ paid: 0, manualReview: 1 });
    expect(h.rpc).toHaveBeenLastCalledWith(
      "complete_smart_checkout_reconciliation",
      expect.objectContaining({
        p_outcome: "manual_review",
        p_failure_code: "receipt_amount_mismatch",
      }),
    );
  });

  it("schedules a read retry after a sanitized transport failure", async () => {
    const h = harness();
    vi.mocked(h.currentAdapter.retrieveCheckout).mockRejectedValueOnce(new Error("secret body"));
    await expect(reconcileSmartCheckoutSessions({
      db: { rpc: h.rpc }, workerId: "qa-worker", gate, resolveContext: h.resolveContext,
    })).resolves.toMatchObject({ retried: 1, paid: 0 });
    expect(h.rpc).toHaveBeenLastCalledWith(
      "complete_smart_checkout_reconciliation",
      expect.objectContaining({ p_outcome: "retry", p_failure_code: "provider_transport_error" }),
    );
  });

  it("rejects malformed claims without touching a provider", async () => {
    const h = harness([{ ...claim, amount_cents: -1 }]);
    await expect(reconcileSmartCheckoutSessions({
      db: { rpc: h.rpc }, workerId: "qa-worker", gate, resolveContext: h.resolveContext,
    })).resolves.toMatchObject({ ok: false, processed: 0, errors: 1 });
    expect(h.resolveContext).not.toHaveBeenCalled();
  });

  it("does not claim database work outside the explicit sandbox gate", async () => {
    const h = harness();
    await expect(reconcileSmartCheckoutSessions({
      db: { rpc: h.rpc },
      workerId: "qa-worker",
      gate: { environment: "production", reconciliationEnabled: true },
      resolveContext: h.resolveContext,
    })).resolves.toMatchObject({ ok: true, code: "disabled", processed: 0 });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.resolveContext).not.toHaveBeenCalled();
  });
});
