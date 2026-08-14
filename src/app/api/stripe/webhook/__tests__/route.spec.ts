import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  claimWebhook: vi.fn(),
  finishWebhook: vi.fn(),
  markCheckout: vi.fn(),
  closeCheckout: vi.fn(),
  privateOfferBySalon: vi.fn(),
  privateOfferByToken: vi.fn(),
  privateOfferIdentity: vi.fn(),
  resolveBillingTerm: vi.fn(),
  bookingUpdateResults: [] as Array<{ error: unknown }>,
  bookingUpdate: vi.fn(),
  salonMaybeSingle: vi.fn(),
  salonUpdate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: () => ({
    webhooks: { constructEvent: mocks.constructEvent },
  }),
  getStripeWebhookSecret: () => "whsec_test_only",
}));
vi.mock("@/shared/subscriptions/stripeWebhookLedger", () => ({
  claimStripeWebhookEvent: (...args: unknown[]) => mocks.claimWebhook(...args),
  finishStripeWebhookEvent: (...args: unknown[]) =>
    mocks.finishWebhook(...args),
}));
vi.mock("@/shared/subscriptions/stripeCheckoutLedger", () => ({
  markStripeSubscriptionCheckoutCompleted: (...args: unknown[]) =>
    mocks.markCheckout(...args),
  closeStripeSubscriptionCheckout: (...args: unknown[]) =>
    mocks.closeCheckout(...args),
}));
vi.mock("@/shared/sales/privateOffers", () => ({
  getPrivateOfferBySalonId: (...args: unknown[]) =>
    mocks.privateOfferBySalon(...args),
  getPrivateOffer: (...args: unknown[]) => mocks.privateOfferByToken(...args),
  privateOfferIdentity: (...args: unknown[]) =>
    mocks.privateOfferIdentity(...args),
  resolvePrivateOfferBillingTerm: (...args: unknown[]) =>
    mocks.resolveBillingTerm(...args),
}));
vi.mock("@/shared/subscriptions/tenantPause", () => ({
  graceDeadline: () => "2026-08-21T00:00:00.000Z",
  resumeTenant: vi.fn(),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "salons") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.salonMaybeSingle }),
          }),
          update: (patch: unknown) => ({
            eq: (column: string, value: unknown) =>
              mocks.salonUpdate(patch, column, value),
          }),
        };
      }
      if (table !== "bookings") {
        throw new Error(`Unexpected table in webhook test: ${table}`);
      }
      const chain = {
        update: (patch: unknown) => {
          mocks.bookingUpdate(patch);
          return chain;
        },
        eq: () => chain,
        neq: async () => mocks.bookingUpdateResults.shift() ?? { error: null },
      };
      return chain;
    },
  }),
}));

import { POST } from "@/app/api/stripe/webhook/route";
import { NextRequest } from "next/server";

const EVENT_ID = "evt_checkout_guard_1";
const SALON_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_1 = "11111111-1111-4111-8111-111111111111";
const LEASE_2 = "22222222-2222-4222-8222-222222222222";

function request() {
  return new NextRequest("https://example.test/api/stripe/webhook", {
    method: "POST",
    body: "{}",
    headers: { "stripe-signature": "test-signature" },
  });
}

function event(
  type = "customer.created",
  object: Record<string, unknown> = { id: "cus_test" },
): Stripe.Event {
  return {
    id: EVENT_ID,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

describe("Stripe webhook event ledger", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("STRIPE_PRICE_PRO", "price_pro_test");
    vi.stubEnv("STRIPE_PRICE_PREMIUM", "price_premium_test");
    mocks.constructEvent.mockReset();
    mocks.claimWebhook.mockReset();
    mocks.finishWebhook.mockReset();
    mocks.markCheckout.mockReset();
    mocks.closeCheckout.mockReset();
    mocks.privateOfferBySalon.mockReset();
    mocks.privateOfferByToken.mockReset();
    mocks.privateOfferIdentity.mockReset();
    mocks.resolveBillingTerm.mockReset();
    mocks.bookingUpdate.mockReset();
    mocks.salonMaybeSingle.mockReset();
    mocks.salonUpdate.mockReset();
    mocks.bookingUpdateResults.length = 0;
    mocks.constructEvent.mockReturnValue(event());
    mocks.claimWebhook.mockResolvedValue({
      outcome: "acquired",
      leaseToken: LEASE_1,
      attemptCount: 1,
    });
    mocks.finishWebhook.mockResolvedValue(true);
    mocks.markCheckout.mockResolvedValue("marked");
    mocks.closeCheckout.mockResolvedValue(true);
    mocks.salonUpdate.mockResolvedValue({ error: null });
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllEnvs();
  });

  it("claims and completes a verified event before acknowledging it", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      ignored: "customer.created",
    });
    expect(mocks.claimWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        eventType: "customer.created",
      }),
    );
    expect(mocks.finishWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        leaseToken: LEASE_1,
        outcome: "processed",
        errorCode: null,
      }),
    );
  });

  it("acknowledges a completed replay without running the handler again", async () => {
    mocks.claimWebhook.mockResolvedValueOnce({
      outcome: "duplicate",
      leaseToken: null,
      attemptCount: 1,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      duplicate: true,
      state: "duplicate",
    });
    expect(mocks.finishWebhook).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("fences concurrent delivery without acknowledging the in-flight copy", async () => {
    let releaseFinish!: (value: boolean) => void;
    const blockedFinish = new Promise<boolean>((resolve) => {
      releaseFinish = resolve;
    });
    mocks.finishWebhook.mockReturnValueOnce(blockedFinish);
    mocks.claimWebhook
      .mockResolvedValueOnce({
        outcome: "acquired",
        leaseToken: LEASE_1,
        attemptCount: 1,
      })
      .mockResolvedValueOnce({
        outcome: "in_progress",
        leaseToken: null,
        attemptCount: 1,
      });

    const first = POST(request());
    await vi.waitFor(() =>
      expect(mocks.finishWebhook).toHaveBeenCalledTimes(1),
    );
    const second = await POST(request());

    expect(second.status).toBe(503);
    await expect(second.json()).resolves.toMatchObject({
      ok: false,
      error: "event_in_progress",
    });
    expect(mocks.finishWebhook).toHaveBeenCalledTimes(1);

    releaseFinish(true);
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it("updates only when metadata is bound to the persisted Stripe customer", async () => {
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.completed", {
        id: "cs_bound",
        customer: "cus_bound",
        subscription: "sub_bound",
        payment_status: "paid",
        client_reference_id: SALON_ID,
        metadata: { salon_id: SALON_ID, plan: "pro" },
      }),
    );
    mocks.salonMaybeSingle
      .mockResolvedValueOnce({
        data: {
          id: SALON_ID,
          stripe_customer_id: "cus_bound",
          stripe_subscription_id: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          archived_at: null,
          tenant_pause_reason: null,
          payment_grace_ends_at: null,
        },
        error: null,
      });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.salonUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_plan: "pro",
        stripe_customer_id: "cus_bound",
        stripe_subscription_id: "sub_bound",
      }),
      "id",
      SALON_ID,
    );
    expect(mocks.finishWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "processed" }),
    );
    expect(mocks.markCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: SALON_ID,
        checkoutSessionId: "cs_bound",
        providerStatus: "payment_succeeded",
      }),
    );
  });

  it("records delayed Checkout as pending without activating the salon", async () => {
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.completed", {
        id: "cs_delayed",
        customer: "cus_bound",
        subscription: "sub_bound",
        payment_status: "unpaid",
        payment_method_types: ["us_bank_account"],
        client_reference_id: SALON_ID,
        metadata: { salon_id: SALON_ID, plan: "pro" },
      }),
    );
    mocks.salonMaybeSingle.mockResolvedValueOnce({
      data: {
        id: SALON_ID,
        stripe_customer_id: "cus_bound",
        stripe_subscription_id: null,
      },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.markCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ providerStatus: "payment_pending" }),
    );
    expect(mocks.salonUpdate).not.toHaveBeenCalled();
  });

  it("activates an idempotent async-payment success", async () => {
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.async_payment_succeeded", {
        id: "cs_delayed",
        customer: "cus_bound",
        subscription: "sub_bound",
        payment_status: "paid",
        payment_method_types: ["us_bank_account"],
        client_reference_id: SALON_ID,
        metadata: { salon_id: SALON_ID, plan: "pro" },
      }),
    );
    mocks.markCheckout.mockResolvedValueOnce("duplicate");
    mocks.salonMaybeSingle
      .mockResolvedValueOnce({
        data: {
          id: SALON_ID,
          stripe_customer_id: "cus_bound",
          stripe_subscription_id: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          archived_at: null,
          tenant_pause_reason: null,
          payment_grace_ends_at: null,
        },
        error: null,
      });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.markCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ providerStatus: "payment_succeeded" }),
    );
    expect(mocks.salonUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_plan: "pro",
        subscription_status: "active",
      }),
      "id",
      SALON_ID,
    );
  });

  it("records async-payment failure without granting a paid plan", async () => {
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.async_payment_failed", {
        id: "cs_delayed",
        customer: "cus_bound",
        subscription: "sub_bound",
        payment_status: "unpaid",
        payment_method_types: ["us_bank_account"],
        client_reference_id: SALON_ID,
        metadata: { salon_id: SALON_ID, plan: "pro" },
      }),
    );
    mocks.salonMaybeSingle.mockResolvedValueOnce({
      data: {
        id: SALON_ID,
        stripe_customer_id: "cus_bound",
        stripe_subscription_id: null,
      },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.markCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ providerStatus: "payment_failed" }),
    );
    expect(mocks.salonUpdate).not.toHaveBeenCalled();
  });

  it("allows a completed card-only subscription that needs no immediate payment", async () => {
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.completed", {
        id: "cs_card_trial",
        customer: "cus_bound",
        subscription: "sub_bound",
        payment_status: "no_payment_required",
        payment_method_types: ["card"],
        client_reference_id: SALON_ID,
        metadata: { salon_id: SALON_ID, plan: "pro" },
      }),
    );
    mocks.salonMaybeSingle
      .mockResolvedValueOnce({
        data: {
          id: SALON_ID,
          stripe_customer_id: "cus_bound",
          stripe_subscription_id: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          archived_at: null,
          tenant_pause_reason: null,
          payment_grace_ends_at: null,
        },
        error: null,
      });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.salonUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ subscription_status: "active" }),
      "id",
      SALON_ID,
    );
  });

  it("fails closed when webhook metadata points at a different customer", async () => {
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.completed", {
        id: "cs_mismatch",
        customer: "cus_attacker",
        subscription: "sub_attacker",
        payment_status: "paid",
        client_reference_id: SALON_ID,
        metadata: { salon_id: SALON_ID, plan: "premium" },
      }),
    );
    mocks.salonMaybeSingle.mockResolvedValueOnce({
      data: {
        id: SALON_ID,
        stripe_customer_id: "cus_bound",
        stripe_subscription_id: "sub_bound",
      },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.salonUpdate).not.toHaveBeenCalled();
    expect(mocks.finishWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "handler_failed",
      }),
    );
  });

  it("keeps an unbound subscription event retryable instead of acknowledging it", async () => {
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.completed", {
        id: "cs_unbound",
        customer: "cus_unbound",
        subscription: "sub_unbound",
        payment_status: "paid",
        client_reference_id: SALON_ID,
        metadata: { salon_id: SALON_ID, plan: "pro" },
      }),
    );
    mocks.salonMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.salonUpdate).not.toHaveBeenCalled();
    expect(mocks.finishWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "salon_binding_not_found",
      }),
    );
  });

  it("fails closed before mutation when Checkout plan metadata is invalid", async () => {
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.completed", {
        id: "cs_invalid_plan",
        customer: "cus_bound",
        subscription: "sub_bound",
        payment_status: "paid",
        client_reference_id: SALON_ID,
        metadata: { salon_id: SALON_ID, plan: "enterprise" },
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.salonMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.salonUpdate).not.toHaveBeenCalled();
    expect(mocks.finishWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "plan_metadata_invalid",
      }),
    );
  });

  it("fails closed before mutation when a subscription price is unmapped", async () => {
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", {
        id: "sub_bound",
        customer: "cus_bound",
        status: "active",
        metadata: { salon_id: SALON_ID },
        items: { data: [{ price: { id: "price_unknown" } }] },
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.salonMaybeSingle).not.toHaveBeenCalled();
    expect(mocks.salonUpdate).not.toHaveBeenCalled();
    expect(mocks.finishWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "price_mapping_unknown",
      }),
    );
  });

  it("validates an inline private-offer Price against durable trusted terms", async () => {
    const offer = {
      accessKey: "private-token",
      salonId: SALON_ID,
      salonName: "Tenant One",
      salonSlug: "tenant-one",
      monthlyAmountCents: 14_900,
      monthlySetupAmountCents: 29_900,
      annualAmountCents: 149_000,
      plan: "pro" as const,
      agreementVersion: "agreement-v1",
    };
    mocks.privateOfferBySalon.mockReturnValue(offer);
    mocks.privateOfferIdentity.mockReturnValue(
      `founder:${SALON_ID}:agreement-v1`,
    );
    mocks.resolveBillingTerm.mockReturnValue({
      schedule: "monthly",
      amountCents: 14_900,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      setupFeeAmountCents: 29_900,
    });
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", {
        id: "sub_private",
        customer: "cus_private",
        status: "active",
        metadata: {
          salon_id: SALON_ID,
          plan: "pro",
          pricing_source: "private_offer",
          private_offer_identity: `founder:${SALON_ID}:agreement-v1`,
          billing_schedule: "monthly",
          recurring_amount_cents: "14900",
          billing_currency: "usd",
          billing_interval: "month",
          billing_interval_count: "1",
        },
        items: {
          data: [
            {
              price: {
                id: "price_inline_generated",
                unit_amount: 14_900,
                currency: "usd",
                recurring: { interval: "month", interval_count: 1 },
              },
            },
          ],
        },
      }),
    );
    mocks.salonMaybeSingle
      .mockResolvedValueOnce({
        data: {
          id: SALON_ID,
          stripe_customer_id: "cus_private",
          stripe_subscription_id: "sub_private",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          archived_at: null,
          tenant_pause_reason: null,
          payment_grace_ends_at: null,
        },
        error: null,
      });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.salonUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_plan: "pro",
        subscription_status: "active",
        stripe_subscription_id: "sub_private",
      }),
      "id",
      SALON_ID,
    );
  });

  it("fails closed when inline private-offer amount drifts from trusted terms", async () => {
    const offer = {
      accessKey: "private-token",
      salonId: SALON_ID,
      plan: "pro" as const,
      agreementVersion: "agreement-v1",
    };
    mocks.privateOfferBySalon.mockReturnValue(offer);
    mocks.privateOfferIdentity.mockReturnValue(
      `founder:${SALON_ID}:agreement-v1`,
    );
    mocks.resolveBillingTerm.mockReturnValue({
      schedule: "monthly",
      amountCents: 14_900,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      setupFeeAmountCents: 29_900,
    });
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", {
        id: "sub_private",
        customer: "cus_private",
        status: "active",
        metadata: {
          salon_id: SALON_ID,
          plan: "pro",
          pricing_source: "private_offer",
          private_offer_identity: `founder:${SALON_ID}:agreement-v1`,
          billing_schedule: "monthly",
        },
        items: {
          data: [
            {
              price: {
                id: "price_inline_tampered",
                unit_amount: 1,
                currency: "usd",
                recurring: { interval: "month", interval_count: 1 },
              },
            },
          ],
        },
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.salonUpdate).not.toHaveBeenCalled();
    expect(mocks.finishWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "private_offer_terms_invalid",
      }),
    );
  });

  it("fails closed when a modern private offer omits durable term metadata", async () => {
    const offer = {
      accessKey: "private-token",
      salonId: SALON_ID,
      plan: "pro" as const,
      agreementVersion: "agreement-v1",
    };
    mocks.privateOfferBySalon.mockReturnValue(offer);
    mocks.privateOfferIdentity.mockReturnValue(
      `founder:${SALON_ID}:agreement-v1`,
    );
    mocks.resolveBillingTerm.mockReturnValue({
      schedule: "monthly",
      amountCents: 14_900,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      setupFeeAmountCents: 29_900,
    });
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", {
        id: "sub_private",
        customer: "cus_private",
        status: "active",
        metadata: {
          salon_id: SALON_ID,
          plan: "pro",
          pricing_source: "private_offer",
          private_offer_identity: `founder:${SALON_ID}:agreement-v1`,
          billing_schedule: "monthly",
          // recurring_amount_cents is intentionally absent.
          billing_currency: "usd",
          billing_interval: "month",
          billing_interval_count: "1",
        },
        items: {
          data: [
            {
              price: {
                id: "price_inline_generated",
                unit_amount: 14_900,
                currency: "usd",
                recurring: { interval: "month", interval_count: 1 },
              },
            },
          ],
        },
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.salonUpdate).not.toHaveBeenCalled();
    expect(mocks.finishWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "private_offer_terms_invalid",
      }),
    );
  });

  it.each([
    ["active", "active"],
    ["trialing", "trialing"],
    ["past_due", "past_due"],
    ["incomplete", "past_due"],
    ["unpaid", "past_due"],
    ["paused", "past_due"],
    ["canceled", "canceled"],
    ["incomplete_expired", "canceled"],
  ] as const)(
    "maps provider subscription status %s to non-escalating local status %s",
    async (providerStatus, localStatus) => {
      mocks.constructEvent.mockReturnValue(
        event("customer.subscription.updated", {
          id: "sub_bound",
          customer: "cus_bound",
          status: providerStatus,
          metadata: {
            salon_id: SALON_ID,
            plan: "pro",
            pricing_source: "stripe_catalog",
            catalog_price_id: "price_pro_test",
          },
          items: { data: [{ price: { id: "price_pro_test" } }] },
        }),
      );
      mocks.salonMaybeSingle
        .mockResolvedValueOnce({
          data: {
            id: SALON_ID,
            stripe_customer_id: "cus_bound",
            stripe_subscription_id: "sub_bound",
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            archived_at: null,
            tenant_pause_reason: null,
            payment_grace_ends_at: null,
          },
          error: null,
        });

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(mocks.salonUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_status: localStatus,
          ...(localStatus === "canceled"
            ? {
                subscription_plan: "free",
                stripe_subscription_id: null,
              }
            : {}),
        }),
        "id",
        SALON_ID,
      );
      if (localStatus === "canceled") {
        expect(mocks.closeCheckout).toHaveBeenCalledWith(
          expect.objectContaining({
            salonId: SALON_ID,
            stripeSubscriptionId: "sub_bound",
          }),
        );
      }
    },
  );

  it("rejects an unknown provider status instead of defaulting to active", async () => {
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", {
        id: "sub_bound",
        customer: "cus_bound",
        status: "future_provider_state",
        metadata: {
          salon_id: SALON_ID,
          plan: "pro",
          pricing_source: "stripe_catalog",
          catalog_price_id: "price_pro_test",
        },
        items: { data: [{ price: { id: "price_pro_test" } }] },
      }),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(mocks.salonUpdate).not.toHaveBeenCalled();
    expect(mocks.finishWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        errorCode: "subscription_status_unsupported",
      }),
    );
  });

  it("fails closed when the persistent event claim is unavailable", async () => {
    mocks.claimWebhook.mockRejectedValueOnce(
      new Error("simulated database outage"),
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.finishWebhook).not.toHaveBeenCalled();
    expect(mocks.bookingUpdate).not.toHaveBeenCalled();
  });

  it("records a failed handler and safely retries the same event", async () => {
    mocks.constructEvent.mockReturnValue(
      event("payment_intent.succeeded", {
        id: "pi_test_deposit",
        metadata: { kind: "booking_deposit" },
      }),
    );
    mocks.claimWebhook
      .mockResolvedValueOnce({
        outcome: "acquired",
        leaseToken: LEASE_1,
        attemptCount: 1,
      })
      .mockResolvedValueOnce({
        outcome: "acquired",
        leaseToken: LEASE_2,
        attemptCount: 2,
      });
    mocks.bookingUpdateResults.push(
      { error: { message: "simulated write failure" } },
      { error: null },
    );

    const failed = await POST(request());
    const recovered = await POST(request());

    expect(failed.status).toBe(500);
    expect(recovered.status).toBe(200);
    expect(mocks.bookingUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.finishWebhook).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        leaseToken: LEASE_1,
        outcome: "failed",
        errorCode: "handler_failed",
      }),
    );
    expect(mocks.finishWebhook).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        leaseToken: LEASE_2,
        outcome: "processed",
        errorCode: null,
      }),
    );
  });

  it("does not acknowledge a stale completion lease", async () => {
    mocks.finishWebhook.mockResolvedValueOnce(false);

    await expect(POST(request())).rejects.toThrow("stripe_webhook_stale_lease");
  });
});
