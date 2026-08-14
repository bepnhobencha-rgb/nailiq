import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/subscriptions/stripeCheckoutLedger", () => ({
  reconcileStripeSubscriptionCheckout: (...args: unknown[]) =>
    mocks.reconcile(...args),
}));

import { reconcileExpiredStripeCheckout } from "@/shared/subscriptions/stripeCheckoutReconciliation";

const NOW = new Date("2026-08-14T04:00:00.000Z");
const CLAIM = {
  outcome: "reconcile" as const,
  idempotencyKey: "checkout-key",
  checkoutUrl: null,
  leaseToken: "lease-one",
  reservedPlan: "pro" as const,
  checkoutSessionId: "cs_one",
  expiresAt: "2026-08-14T03:00:00.000Z",
  requestedAt: "2026-08-13T03:00:00.000Z",
};

function stripe(): Stripe {
  return {
    checkout: { sessions: { retrieve: mocks.retrieve } },
  } as unknown as Stripe;
}

describe("expired Stripe Checkout reconciliation", () => {
  beforeEach(() => {
    mocks.retrieve.mockReset();
    mocks.reconcile.mockReset();
    mocks.reconcile.mockResolvedValue(true);
  });

  it("reuses provider-open truth instead of rotating an idempotency generation", async () => {
    mocks.retrieve.mockResolvedValue({
      id: "cs_one",
      status: "open",
      customer: "cus_one",
      subscription: null,
      client_reference_id: "salon-one",
      url: "https://checkout.stripe.test/cs_one",
      expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
    });

    await expect(
      reconcileExpiredStripeCheckout({
        stripe: stripe(),
        salonId: "salon-one",
        expectedCustomerId: "cus_one",
        claim: CLAIM,
        now: NOW,
      }),
    ).resolves.toEqual({
      outcome: "reuse",
      url: "https://checkout.stripe.test/cs_one",
    });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "open", providerStatus: "open" }),
    );
  });

  it("durably blocks a completed provider Session beyond local URL expiry", async () => {
    mocks.retrieve.mockResolvedValue({
      id: "cs_one",
      status: "complete",
      payment_status: "paid",
      customer: "cus_one",
      subscription: "sub_one",
      client_reference_id: "salon-one",
    });

    await expect(
      reconcileExpiredStripeCheckout({
        stripe: stripe(),
        salonId: "salon-one",
        expectedCustomerId: "cus_one",
        claim: CLAIM,
        now: NOW,
      }),
    ).resolves.toEqual({ outcome: "blocked" });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "completed",
        stripeSubscriptionId: "sub_one",
        providerStatus: "payment_succeeded",
      }),
    );
  });

  it("closes only when provider truth says the Session expired without a subscription", async () => {
    mocks.retrieve.mockResolvedValue({
      id: "cs_one",
      status: "expired",
      customer: "cus_one",
      subscription: null,
      client_reference_id: "salon-one",
    });

    await expect(
      reconcileExpiredStripeCheckout({
        stripe: stripe(),
        salonId: "salon-one",
        expectedCustomerId: "cus_one",
        claim: CLAIM,
        now: NOW,
      }),
    ).resolves.toEqual({ outcome: "closed" });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "closed",
        providerStatus: "checkout_expired",
      }),
    );
  });

  it("fails closed on a provider/customer binding mismatch", async () => {
    mocks.retrieve.mockResolvedValue({
      id: "cs_one",
      status: "expired",
      customer: "cus_other",
      subscription: null,
      client_reference_id: "salon-one",
    });

    await expect(
      reconcileExpiredStripeCheckout({
        stripe: stripe(),
        salonId: "salon-one",
        expectedCustomerId: "cus_one",
        claim: CLAIM,
        now: NOW,
      }),
    ).resolves.toEqual({ outcome: "failed" });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "retryable_failure" }),
    );
  });
});
