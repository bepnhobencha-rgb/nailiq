import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  unstableRethrow: vi.fn(),
  headers: vi.fn(),
  getStripeClient: vi.fn(),
  getStripeReturnOrigin: vi.fn(),
  getPrivateOffer: vi.fn(),
  privateOfferIdentity: vi.fn(),
  resolveBillingTerm: vi.fn(),
  fingerprint: vi.fn(),
  claimCheckout: vi.fn(),
  finishCheckout: vi.fn(),
  reconcileProvider: vi.fn(),
  salonMaybeSingle: vi.fn(),
  persistCustomerBinding: vi.fn(),
  membersIn: vi.fn(),
  getUserById: vi.fn(),
  customersCreate: vi.fn(),
  checkoutCreate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: () => mocks.headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => mocks.redirect(...args),
  unstable_rethrow: (error: unknown) => mocks.unstableRethrow(error),
}));
vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: () => mocks.getStripeClient(),
  getStripeReturnOrigin: () => mocks.getStripeReturnOrigin(),
}));
vi.mock("@/shared/sales/privateOffers", () => ({
  getPrivateOffer: (...args: unknown[]) => mocks.getPrivateOffer(...args),
  privateOfferIdentity: (...args: unknown[]) =>
    mocks.privateOfferIdentity(...args),
  resolvePrivateOfferBillingTerm: (...args: unknown[]) =>
    mocks.resolveBillingTerm(...args),
}));
vi.mock("@/shared/subscriptions/stripeCheckoutFingerprint", () => ({
  stripeCheckoutRequestFingerprint: (...args: unknown[]) =>
    mocks.fingerprint(...args),
}));
vi.mock("@/shared/subscriptions/stripeCheckoutLedger", () => ({
  claimStripeSubscriptionCheckout: (...args: unknown[]) =>
    mocks.claimCheckout(...args),
  finishStripeSubscriptionCheckout: (...args: unknown[]) =>
    mocks.finishCheckout(...args),
}));
vi.mock("@/shared/subscriptions/stripeCheckoutReconciliation", () => ({
  reconcileExpiredStripeCheckout: (...args: unknown[]) =>
    mocks.reconcileProvider(...args),
}));
vi.mock("@/shared/subscriptions/stripeCustomerBinding", () => ({
  persistStripeCustomerBinding: (...args: unknown[]) =>
    mocks.persistCustomerBinding(...args),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    auth: { admin: { getUserById: mocks.getUserById } },
    from: (table: string) => {
      if (table === "salons") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.salonMaybeSingle }),
          }),
        };
      }
      if (table === "salon_members") {
        return {
          select: () => ({
            eq: () => ({ in: mocks.membersIn }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));

import { startPrivateOfferCheckout } from "@/app/offer/[token]/actions";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const OFFER = {
  accessKey: "test-private-offer",
  salonId: SALON_ID,
  salonName: "Tenant One",
  salonSlug: "tenant-one",
  monthlyAmountCents: 14_900,
  monthlySetupAmountCents: 29_900,
  quarterlyAmountCents: 44_700,
  semiannualAmountCents: 89_400,
  annualAmountCents: 149_000,
  plan: "pro" as const,
  agreementVersion: "agreement-v1",
};
const CLAIM = {
  outcome: "acquired" as const,
  idempotencyKey: `nailiq:subscription-checkout:${SALON_ID}:pro:1`,
  checkoutUrl: null,
  leaseToken: "22222222-2222-4222-8222-222222222222",
  reservedPlan: "pro" as const,
  checkoutSessionId: null,
  expiresAt: "2099-08-15T00:00:00.000Z",
  requestedAt: "2026-08-14T00:00:00.000Z",
};

function formData(): FormData {
  const data = new FormData();
  data.set("signerName", "Owner One");
  data.set("signerTitle", "Owner");
  data.set("businessLegalName", "Tenant One LLC");
  data.set("signerEmail", "owner@example.test");
  data.set("agreementAccepted", "yes");
  data.set("authorityAccepted", "yes");
  data.set("renewalAccepted", "yes");
  data.set("billingSchedule", "monthly");
  return data;
}

describe("private-offer subscription Checkout idempotency", () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) value.mockReset();

    mocks.redirect.mockImplementation((url: string) => {
      const error = new Error(`redirect:${url}`) as Error & { digest: string };
      error.digest = "NEXT_REDIRECT";
      throw error;
    });
    mocks.unstableRethrow.mockImplementation(
      (error: Error & { digest?: string }) => {
        if (error?.digest === "NEXT_REDIRECT") throw error;
      },
    );
    mocks.headers.mockResolvedValue(
      new Headers({ "x-forwarded-for": "203.0.113.10" }),
    );
    mocks.getStripeReturnOrigin.mockReturnValue("https://example.test");
    mocks.getPrivateOffer.mockReturnValue(OFFER);
    mocks.privateOfferIdentity.mockReturnValue(
      `founder:${SALON_ID}:${OFFER.agreementVersion}`,
    );
    mocks.resolveBillingTerm.mockReturnValue({
      schedule: "monthly",
      amountCents: 14_900,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      setupFeeAmountCents: 29_900,
    });
    mocks.fingerprint.mockReturnValue("a".repeat(64));
    mocks.claimCheckout.mockResolvedValue(CLAIM);
    mocks.finishCheckout.mockResolvedValue(true);
    mocks.salonMaybeSingle.mockResolvedValue({
      data: {
        id: SALON_ID,
        name: "Tenant One",
        slug: "tenant-one",
        stripe_customer_id: "cus_existing",
        stripe_subscription_id: null,
      },
      error: null,
    });
    mocks.persistCustomerBinding.mockResolvedValue(undefined);
    mocks.membersIn.mockResolvedValue({
      data: [{ user_id: "owner-1", role: "owner" }],
      error: null,
    });
    mocks.getUserById.mockResolvedValue({
      data: { user: { email: "owner@example.test" } },
      error: null,
    });
    mocks.customersCreate.mockResolvedValue({ id: "cus_created" });
    mocks.checkoutCreate.mockResolvedValue({
      id: "cs_private_once",
      url: "https://checkout.stripe.test/cs_private_once",
      expires_at: 4_089_830_400,
    });
    mocks.getStripeClient.mockReturnValue({
      customers: { create: mocks.customersCreate },
      checkout: { sessions: { create: mocks.checkoutCreate } },
    });
  });

  it("fingerprints exact offer terms and publishes the leased session", async () => {
    await expect(
      startPrivateOfferCheckout(OFFER.accessKey, formData()),
    ).rejects.toThrow("redirect:https://checkout.stripe.test/cs_private_once");

    expect(mocks.fingerprint).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: SALON_ID,
        plan: "pro",
        amountCents: 14_900,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        setupFeeAmountCents: 29_900,
        offerIdentity: `founder:${SALON_ID}:${OFFER.agreementVersion}`,
      }),
    );
    expect(mocks.claimCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: SALON_ID,
        plan: "pro",
        requestFingerprint: "a".repeat(64),
      }),
    );
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_existing",
        client_reference_id: SALON_ID,
        metadata: expect.objectContaining({
          salon_id: SALON_ID,
          plan: "pro",
          pricing_source: "private_offer",
          private_offer_identity: `founder:${SALON_ID}:${OFFER.agreementVersion}`,
          recurring_amount_cents: "14900",
          billing_currency: "usd",
          billing_interval: "month",
          billing_interval_count: "1",
          agreement_accepted_at: CLAIM.requestedAt,
        }),
        line_items: expect.arrayContaining([
          expect.objectContaining({
            price_data: expect.objectContaining({
              currency: "usd",
              unit_amount: 14_900,
              recurring: { interval: "month", interval_count: 1 },
              product_data: expect.objectContaining({
                metadata: expect.objectContaining({
                  pricing_source: "private_offer",
                  private_offer_identity: `founder:${SALON_ID}:${OFFER.agreementVersion}`,
                }),
              }),
            }),
          }),
        ]),
      }),
      { idempotencyKey: `${CLAIM.idempotencyKey}:session` },
    );
    expect(mocks.finishCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: SALON_ID,
        leaseToken: CLAIM.leaseToken,
        outcome: "open",
        checkoutSessionId: "cs_private_once",
      }),
    );
  });

  it("serializes simultaneous private-offer clicks before Stripe", async () => {
    let releaseProvider!: () => void;
    const providerBlocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mocks.checkoutCreate.mockImplementationOnce(async () => {
      await providerBlocked;
      return {
        id: "cs_private_concurrent",
        url: "https://checkout.stripe.test/cs_private_concurrent",
        expires_at: 4_089_830_400,
      };
    });
    mocks.claimCheckout.mockResolvedValueOnce(CLAIM).mockResolvedValueOnce({
      ...CLAIM,
      outcome: "pending",
      leaseToken: null,
    });

    const first = startPrivateOfferCheckout(OFFER.accessKey, formData());
    await vi.waitFor(() =>
      expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1),
    );
    await expect(
      startPrivateOfferCheckout(OFFER.accessKey, formData()),
    ).rejects.toThrow(`redirect:/offer/${OFFER.accessKey}?error=stripe`);
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);

    releaseProvider();
    await expect(first).rejects.toThrow(
      "redirect:https://checkout.stripe.test/cs_private_concurrent",
    );
  });

  it("persists a first-time customer before creating its subscription session", async () => {
    mocks.salonMaybeSingle.mockResolvedValueOnce({
      data: {
        id: SALON_ID,
        name: "Tenant One",
        slug: "tenant-one",
        stripe_customer_id: null,
        stripe_subscription_id: null,
      },
      error: null,
    });

    await expect(
      startPrivateOfferCheckout(OFFER.accessKey, formData()),
    ).rejects.toThrow("redirect:https://checkout.stripe.test/cs_private_once");

    expect(mocks.customersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.test",
        metadata: { salon_id: SALON_ID, salon_slug: "tenant-one" },
      }),
      { idempotencyKey: `${CLAIM.idempotencyKey}:customer` },
    );
    expect(mocks.persistCustomerBinding).toHaveBeenCalledWith({
      salonId: SALON_ID,
      stripeCustomerId: "cus_created",
    });
    expect(
      mocks.persistCustomerBinding.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.checkoutCreate.mock.invocationCallOrder[0]);
  });

  it("blocks private-offer recreation when provider reconciliation finds a subscription", async () => {
    mocks.claimCheckout.mockResolvedValueOnce({
      ...CLAIM,
      outcome: "reconcile",
      checkoutSessionId: "cs_private_expired_locally",
    });
    mocks.reconcileProvider.mockResolvedValue({ outcome: "blocked" });

    await expect(
      startPrivateOfferCheckout(OFFER.accessKey, formData()),
    ).rejects.toThrow(
      `redirect:/offer/${OFFER.accessKey}?error=already-active`,
    );

    expect(mocks.reconcileProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: SALON_ID,
        expectedCustomerId: "cus_existing",
      }),
    );
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("starts one new generation only after provider confirms Checkout expiry", async () => {
    mocks.claimCheckout
      .mockResolvedValueOnce({
        ...CLAIM,
        outcome: "reconcile",
        checkoutSessionId: "cs_private_expired",
      })
      .mockResolvedValueOnce({
        ...CLAIM,
        idempotencyKey: `nailiq:subscription-checkout:${SALON_ID}:pro:2`,
      });
    mocks.reconcileProvider.mockResolvedValue({ outcome: "closed" });

    await expect(
      startPrivateOfferCheckout(OFFER.accessKey, formData()),
    ).rejects.toThrow("redirect:https://checkout.stripe.test/cs_private_once");

    expect(mocks.claimCheckout).toHaveBeenCalledTimes(2);
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.any(Object),
      {
        idempotencyKey: `nailiq:subscription-checkout:${SALON_ID}:pro:2:session`,
      },
    );
  });
});
