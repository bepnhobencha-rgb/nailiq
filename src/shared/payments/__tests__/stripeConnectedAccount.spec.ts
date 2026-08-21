import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { StripeProvider } from "@/shared/integrations/payments/stripe";

describe("StripeProvider connected-account routing", () => {
  it("routes charge and refund to the DB-bound Stripe account with stable keys", async () => {
    const create = vi.fn<
      (params: unknown, options: unknown) => Promise<{ id: string; status: string }>
    >().mockResolvedValue({ id: "pi_123456", status: "succeeded" });
    const refund = vi.fn<
      (params: unknown, options: unknown) => Promise<{ id: string; status: string }>
    >().mockResolvedValue({ id: "re_123456", status: "succeeded" });
    const stripe = {
      paymentIntents: { create },
      refunds: { create: refund },
    };
    const provider = new StripeProvider(stripe as never, "cad");

    await provider.chargeSavedCard({
      customerId: "cus_1",
      cardId: "pm_1",
      amountCents: 2_500,
      idempotencyKey: "nq:operation-1",
      providerAccountId: "acct_1",
    });
    await provider.refund({
      paymentId: "pi_123456",
      amountCents: 1_000,
      reason: "partial refund",
      idempotencyKey: "nq:operation-2",
      providerAccountId: "acct_1",
    });

    expect(create.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: "nq:operation-1",
      stripeAccount: "acct_1",
    });
    expect(refund.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: "nq:operation-2",
      stripeAccount: "acct_1",
    });
  });
});
