import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSalonForDashboard: vi.fn(),
  getStripeClient: vi.fn(),
  getStripeReturnOrigin: vi.fn(),
  claimCheckout: vi.fn(),
  finishCheckout: vi.fn(),
  reconcileCheckout: vi.fn(),
  reconcileProvider: vi.fn(),
  maybeSingle: vi.fn(),
  persistCustomerBinding: vi.fn(),
  customersCreate: vi.fn(),
  checkoutCreate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/salonOwnerActions", () => ({
  resolveSalonForDashboard: (...args: unknown[]) =>
    mocks.resolveSalonForDashboard(...args),
}));
vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: () => mocks.getStripeClient(),
  getStripeReturnOrigin: () => mocks.getStripeReturnOrigin(),
}));
vi.mock("@/shared/subscriptions/stripeCheckoutLedger", () => ({
  claimStripeSubscriptionCheckout: (...args: unknown[]) =>
    mocks.claimCheckout(...args),
  finishStripeSubscriptionCheckout: (...args: unknown[]) =>
    mocks.finishCheckout(...args),
  reconcileStripeSubscriptionCheckout: (...args: unknown[]) =>
    mocks.reconcileCheckout(...args),
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
    from: (table: string) => {
      if (table !== "salons") throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: mocks.maybeSingle }),
        }),
      };
    },
  }),
}));

import { createCheckoutSession } from "@/shared/dashboard/stripeActions";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM = {
  outcome: "acquired" as const,
  idempotencyKey: `nailiq:subscription-checkout:${SALON_ID}:pro:1`,
  checkoutUrl: null,
  leaseToken: "22222222-2222-4222-8222-222222222222",
  reservedPlan: "pro" as const,
  checkoutSessionId: null,
  expiresAt: "2026-08-15T00:00:00.000Z",
  requestedAt: "2026-08-14T00:00:00.000Z",
};

function resolved(role = "owner") {
  return {
    salon: { id: SALON_ID },
    kind: "member",
    role,
    viewerEmail: "owner@example.test",
    viewerUserId: "33333333-3333-4333-8333-333333333333",
  };
}

describe("createCheckoutSession billing idempotency", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_PRICE_PRO", "price_core_test");
    vi.stubEnv("STRIPE_PRICE_PREMIUM", "price_studio_test");
    mocks.resolveSalonForDashboard.mockReset();
    mocks.getStripeClient.mockReset();
    mocks.getStripeReturnOrigin.mockReset();
    mocks.claimCheckout.mockReset();
    mocks.finishCheckout.mockReset();
    mocks.reconcileCheckout.mockReset();
    mocks.reconcileProvider.mockReset();
    mocks.maybeSingle.mockReset();
    mocks.persistCustomerBinding.mockReset();
    mocks.customersCreate.mockReset();
    mocks.checkoutCreate.mockReset();

    mocks.resolveSalonForDashboard.mockResolvedValue(resolved());
    mocks.getStripeReturnOrigin.mockReturnValue("https://example.test");
    mocks.getStripeClient.mockReturnValue({
      customers: { create: mocks.customersCreate },
      checkout: { sessions: { create: mocks.checkoutCreate } },
    });
    mocks.claimCheckout.mockResolvedValue(CLAIM);
    mocks.finishCheckout.mockResolvedValue(true);
    mocks.maybeSingle.mockResolvedValue({
      data: {
        id: SALON_ID,
        name: "Tenant One",
        slug: "tenant-one",
        email: "owner@example.test",
        stripe_customer_id: "cus_existing",
      },
      error: null,
    });
    mocks.persistCustomerBinding.mockResolvedValue(undefined);
    mocks.customersCreate.mockResolvedValue({ id: "cus_created" });
    mocks.checkoutCreate.mockResolvedValue({
      id: "cs_test_once",
      url: "https://checkout.stripe.test/cs_test_once",
      expires_at: 1_787_012_800,
    });
  });

  it("binds the claim and Stripe request to the resolved salon and plan", async () => {
    const result = await createCheckoutSession("tenant-one", "pro");

    expect(result).toEqual({
      ok: true,
      url: "https://checkout.stripe.test/cs_test_once",
    });
    expect(mocks.claimCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: SALON_ID,
        plan: "pro",
        requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(mocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_existing",
        client_reference_id: SALON_ID,
        line_items: [{ price: "price_core_test", quantity: 1 }],
        metadata: expect.objectContaining({
          salon_id: SALON_ID,
          plan: "pro",
          pricing_source: "stripe_catalog",
          catalog_price_id: "price_core_test",
        }),
        subscription_data: {
          metadata: expect.objectContaining({
            salon_id: SALON_ID,
            plan: "pro",
            pricing_source: "stripe_catalog",
            catalog_price_id: "price_core_test",
          }),
        },
      }),
      { idempotencyKey: `${CLAIM.idempotencyKey}:session` },
    );
    expect(mocks.finishCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: SALON_ID,
        leaseToken: CLAIM.leaseToken,
        outcome: "open",
        checkoutSessionId: "cs_test_once",
      }),
    );
  });

  it("allows only the owner role to claim a checkout", async () => {
    mocks.resolveSalonForDashboard
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(resolved("admin"));

    await expect(createCheckoutSession("tenant-one", "pro")).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    await expect(createCheckoutSession("tenant-one", "pro")).resolves.toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(mocks.claimCheckout).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it.each([
    "pending",
    "conflicting_plan",
    "conflicting_request",
    "active_subscription",
  ] as const)("fails closed for a %s guard outcome", async (outcome) => {
    mocks.claimCheckout.mockResolvedValueOnce({ ...CLAIM, outcome });

    await expect(createCheckoutSession("tenant-one", "pro")).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("reuses an open same-plan session without another Stripe call", async () => {
    mocks.claimCheckout.mockResolvedValueOnce({
      ...CLAIM,
      outcome: "reuse",
      checkoutUrl: "https://checkout.stripe.test/cs_existing",
      leaseToken: null,
    });

    await expect(createCheckoutSession("tenant-one", "pro")).resolves.toEqual({
      ok: true,
      url: "https://checkout.stripe.test/cs_existing",
    });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("serializes concurrent duplicate clicks before calling Stripe", async () => {
    let releaseProvider!: () => void;
    const providerBlocked = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mocks.checkoutCreate.mockImplementationOnce(async () => {
      await providerBlocked;
      return {
        id: "cs_concurrent",
        url: "https://checkout.stripe.test/cs_concurrent",
        expires_at: 1_787_012_800,
      };
    });
    mocks.claimCheckout.mockResolvedValueOnce(CLAIM).mockResolvedValueOnce({
      ...CLAIM,
      outcome: "pending",
      idempotencyKey: CLAIM.idempotencyKey,
      leaseToken: null,
    });

    const first = createCheckoutSession("tenant-one", "pro");
    await vi.waitFor(() =>
      expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1),
    );
    const second = await createCheckoutSession("tenant-one", "pro");
    expect(second).toEqual({ ok: false, error: "server_error" });
    expect(mocks.checkoutCreate).toHaveBeenCalledTimes(1);

    releaseProvider();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("retries an interrupted provider call with the same session key", async () => {
    mocks.claimCheckout.mockResolvedValueOnce(CLAIM).mockResolvedValueOnce({
      ...CLAIM,
      leaseToken: "test-lease-token",
    });
    mocks.checkoutCreate
      .mockRejectedValueOnce(new Error("simulated connection reset"))
      .mockResolvedValueOnce({
        id: "cs_recovered",
        url: "https://checkout.stripe.test/cs_recovered",
        expires_at: 1_787_012_800,
      });

    await expect(createCheckoutSession("tenant-one", "pro")).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    await expect(createCheckoutSession("tenant-one", "pro")).resolves.toEqual({
      ok: true,
      url: "https://checkout.stripe.test/cs_recovered",
    });

    const requestOptions = mocks.checkoutCreate.mock.calls.map(
      (call) => call[1],
    );
    expect(requestOptions).toEqual([
      { idempotencyKey: `${CLAIM.idempotencyKey}:session` },
      { idempotencyKey: `${CLAIM.idempotencyKey}:session` },
    ]);
    expect(mocks.finishCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "retryable_failure",
        errorCode: "checkout_create_failed",
      }),
    );
  });

  it("uses a separate deterministic key and persists a new customer first", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: {
        id: SALON_ID,
        name: "Tenant One",
        slug: "tenant-one",
        email: "owner@example.test",
        stripe_customer_id: null,
      },
      error: null,
    });

    await expect(
      createCheckoutSession("tenant-one", "pro"),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(mocks.customersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
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

  it("does not create Checkout when the customer mirror cannot be persisted", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: {
        id: SALON_ID,
        name: "Tenant One",
        slug: "tenant-one",
        email: "owner@example.test",
        stripe_customer_id: null,
      },
      error: null,
    });
    mocks.persistCustomerBinding.mockRejectedValueOnce(
      new Error("simulated write failure"),
    );

    await expect(createCheckoutSession("tenant-one", "pro")).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
    expect(mocks.finishCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "retryable_failure",
        errorCode: "customer_persist_failed",
      }),
    );
  });
});
