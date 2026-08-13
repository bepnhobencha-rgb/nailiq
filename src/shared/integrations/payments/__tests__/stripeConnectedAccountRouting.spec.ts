import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { StripeProvider } from "@/shared/integrations/payments/stripe";

const connectedAccountId = "acct_salon_123";

describe("Stripe connected-account routing", () => {
  const paymentIntentCreate = vi.fn();
  const refundCreate = vi.fn();
  const paymentMethodDetach = vi.fn();

  const stripe = {
    paymentIntents: { create: paymentIntentCreate },
    refunds: { create: refundCreate },
    paymentMethods: {
      detach: paymentMethodDetach,
    },
  } as unknown as Stripe;

  beforeEach(() => {
    paymentIntentCreate.mockReset().mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
    });
    refundCreate.mockReset().mockResolvedValue({
      id: "re_1",
      status: "succeeded",
    });
    paymentMethodDetach.mockReset().mockResolvedValue({ id: "pm_1" });
  });

  it("creates the no-show charge on the salon account, never the platform", async () => {
    const provider = new StripeProvider(stripe, connectedAccountId, "cad");

    await provider.chargeSavedCard({
      customerId: "cus_1",
      cardId: "pm_1",
      amountCents: 1_700,
      idempotencyKey: "noshow:booking-1",
      referenceId: "booking:booking-1",
    });

    expect(paymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1_700,
        currency: "cad",
        customer: "cus_1",
        payment_method: "pm_1",
      }),
      {
        idempotencyKey: "noshow:booking-1",
        stripeAccount: connectedAccountId,
      },
    );
  });

  it("routes refunds and saved-card removal to the same salon account", async () => {
    const provider = new StripeProvider(stripe, connectedAccountId, "cad");

    await provider.refund({
      paymentId: "pi_1",
      amountCents: 1_700,
      reason: "No-show fee refund",
      idempotencyKey: "refund:booking-1",
    });
    await provider.removeSavedCard({ cardId: "pm_1", customerId: "cus_1" });

    expect(refundCreate).toHaveBeenCalledWith(
      { payment_intent: "pi_1", amount: 1_700 },
      {
        idempotencyKey: "refund:booking-1",
        stripeAccount: connectedAccountId,
      },
    );
    expect(paymentMethodDetach).toHaveBeenCalledWith(
      "pm_1",
      {},
      { stripeAccount: connectedAccountId },
    );
  });
});
