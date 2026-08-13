import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  selectedSalonId: "",
  paymentProvider: "square" as "square" | "stripe",
  stripeAccountId: null as string | null,
  stripeChargesEnabled: false,
  stripeDetailsSubmitted: false,
}));

const mocks = vi.hoisted(() => ({
  getSquareConfig: vi.fn(),
  chargeSavedCard: vi.fn(),
}));

type Builder = {
  select: (...args: unknown[]) => Builder;
  eq: (column: string, value: unknown) => Builder;
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null }>;
};

vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({
    from: (table: string) => {
      const builder: Builder = {
        select: () => builder,
        eq: (column, value) => {
          if (table === "salons" && column === "id") {
            state.selectedSalonId = String(value);
          }
          return builder;
        },
        maybeSingle: async () =>
          table === "salons"
            ? {
                data: {
                  payment_provider: state.paymentProvider,
                  currency_code: "CAD",
                  stripe_connect_account_id: state.stripeAccountId,
                  stripe_connect_charges_enabled: state.stripeChargesEnabled,
                  stripe_connect_details_submitted: state.stripeDetailsSubmitted,
                },
              }
            : { data: null },
      };
      return builder;
    },
  }),
}));

vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: () => ({}),
}));

vi.mock("@/shared/integrations/square/client", () => ({
  getSquareConfig: mocks.getSquareConfig,
  ensureSquareCustomer: vi.fn(),
  saveCardOnFile: vi.fn(),
  chargeSavedCard: mocks.chargeSavedCard,
  refundPayment: vi.fn(),
  disableCard: vi.fn(),
  findSquareCustomerByPhone: vi.fn(),
  listCards: vi.fn(),
}));

import { resolvePaymentProvider } from "@/shared/integrations/payments";

describe("payment-provider tenant isolation", () => {
  beforeEach(() => {
    state.selectedSalonId = "";
    state.paymentProvider = "square";
    state.stripeAccountId = null;
    state.stripeChargesEnabled = false;
    state.stripeDetailsSubmitted = false;
    mocks.getSquareConfig.mockReset().mockImplementation(async (_db, salonId) => ({
      salonId,
      merchantId: `merchant:${salonId}`,
      locationId: `location:${salonId}`,
      accessToken: `token:${salonId}`,
      applicationId: `app:${salonId}`,
      environment: "sandbox",
      currency: "USD",
      sync: {},
    }));
    mocks.chargeSavedCard.mockReset().mockResolvedValue({
      paymentId: "payment-1",
      status: "COMPLETED",
    });
  });

  it("loads and uses Square credentials for the requested salon only", async () => {
    const salonA = "11111111-1111-4111-8111-111111111111";
    const salonB = "22222222-2222-4222-8222-222222222222";

    const providerA = await resolvePaymentProvider(salonA);
    const providerB = await resolvePaymentProvider(salonB);

    expect(providerA?.kind).toBe("square");
    expect(providerB?.kind).toBe("square");
    expect(mocks.getSquareConfig).toHaveBeenNthCalledWith(1, expect.anything(), salonA);
    expect(mocks.getSquareConfig).toHaveBeenNthCalledWith(2, expect.anything(), salonB);

    await providerA?.chargeSavedCard({
      customerId: "customer-a",
      cardId: "card-a",
      amountCents: 1_700,
      idempotencyKey: "charge-a",
    });
    await providerB?.chargeSavedCard({
      customerId: "customer-b",
      cardId: "card-b",
      amountCents: 2_000,
      idempotencyKey: "charge-b",
    });

    expect(mocks.chargeSavedCard.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        salonId: salonA,
        accessToken: `token:${salonA}`,
      }),
    );
    expect(mocks.chargeSavedCard.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        salonId: salonB,
        accessToken: `token:${salonB}`,
      }),
    );
  });

  it("refuses Stripe until this salon's connected account is fully enabled", async () => {
    state.paymentProvider = "stripe";
    state.stripeAccountId = "acct_salon_123";

    await expect(
      resolvePaymentProvider("33333333-3333-4333-8333-333333333333"),
    ).resolves.toBeNull();

    state.stripeChargesEnabled = true;
    await expect(
      resolvePaymentProvider("33333333-3333-4333-8333-333333333333"),
    ).resolves.toBeNull();

    state.stripeDetailsSubmitted = true;
    await expect(
      resolvePaymentProvider("33333333-3333-4333-8333-333333333333"),
    ).resolves.toMatchObject({ kind: "stripe" });
  });
});
