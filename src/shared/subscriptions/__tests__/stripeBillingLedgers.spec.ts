import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import {
  claimStripeSubscriptionCheckout,
  finishStripeSubscriptionCheckout,
} from "@/shared/subscriptions/stripeCheckoutLedger";
import {
  claimStripeWebhookEvent,
  finishStripeWebhookEvent,
} from "@/shared/subscriptions/stripeWebhookLedger";
import { stripeCheckoutRequestFingerprint } from "@/shared/subscriptions/stripeCheckoutFingerprint";

const NOW = new Date("2026-08-14T04:00:00.000Z");

describe("Stripe billing database ledgers", () => {
  beforeEach(() => mocks.rpc.mockReset());

  it("maps a salon-and-plan checkout claim without exposing database shapes", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [
        {
          outcome: "acquired",
          idempotency_key: "nailiq:subscription-checkout:salon-1:pro:1",
          checkout_url: null,
          lease_token: "lease-1",
          reserved_plan: "pro",
          checkout_session_id: null,
          expires_at: "2026-08-15T04:00:00.000Z",
          requested_at: "2026-08-14T04:00:00.000Z",
        },
      ],
      error: null,
    });

    await expect(
      claimStripeSubscriptionCheckout({
        salonId: "salon-1",
        plan: "pro",
        requestFingerprint: "a".repeat(64),
        now: NOW,
      }),
    ).resolves.toEqual({
      outcome: "acquired",
      idempotencyKey: "nailiq:subscription-checkout:salon-1:pro:1",
      checkoutUrl: null,
      leaseToken: "lease-1",
      reservedPlan: "pro",
      checkoutSessionId: null,
      expiresAt: "2026-08-15T04:00:00.000Z",
      requestedAt: "2026-08-14T04:00:00.000Z",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_stripe_subscription_checkout",
      {
        p_salon_id: "salon-1",
        p_plan: "pro",
        p_request_fingerprint: "a".repeat(64),
        p_now: NOW.toISOString(),
      },
    );
  });

  it("hashes the full Checkout descriptor deterministically and sensitively", () => {
    const descriptor = {
      salonId: "salon-1",
      plan: "pro",
      amountCents: 14_900,
      currency: "usd",
      interval: "month",
      offerIdentity: "offer-a",
    } as const;
    const first = stripeCheckoutRequestFingerprint(descriptor);
    const retry = stripeCheckoutRequestFingerprint({ ...descriptor });
    const changedAmount = stripeCheckoutRequestFingerprint({
      ...descriptor,
      amountCents: 15_000,
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(retry).toBe(first);
    expect(changedAmount).not.toBe(first);
  });

  it("fences checkout completion with the exact lease token", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });

    await expect(
      finishStripeSubscriptionCheckout({
        salonId: "salon-1",
        leaseToken: "lease-1",
        outcome: "open",
        checkoutSessionId: "cs_test_1",
        checkoutUrl: "https://checkout.stripe.test/cs_test_1",
        expiresAt: "2026-08-15T04:00:00.000Z",
        now: NOW,
      }),
    ).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "finish_stripe_subscription_checkout",
      expect.objectContaining({
        p_salon_id: "salon-1",
        p_lease_token: "lease-1",
        p_outcome: "open",
      }),
    );
  });

  it("claims a Stripe event by provider event id and attempt", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ outcome: "acquired", lease_token: "event-lease", attempt_count: 2 }],
      error: null,
    });

    await expect(
      claimStripeWebhookEvent({
        eventId: "evt_test_1",
        eventType: "checkout.session.completed",
        now: NOW,
      }),
    ).resolves.toEqual({
      outcome: "acquired",
      leaseToken: "event-lease",
      attemptCount: 2,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_stripe_webhook_event", {
      p_event_id: "evt_test_1",
      p_event_type: "checkout.session.completed",
      p_now: NOW.toISOString(),
    });
  });

  it("records only an allowlisted webhook failure code", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });

    await expect(
      finishStripeWebhookEvent({
        eventId: "evt_test_1",
        leaseToken: "event-lease",
        outcome: "failed",
        errorCode: "handler_failed",
        now: NOW,
      }),
    ).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("finish_stripe_webhook_event", {
      p_event_id: "evt_test_1",
      p_lease_token: "event-lease",
      p_outcome: "failed",
      p_error_code: "handler_failed",
      p_now: NOW.toISOString(),
    });
  });

  it("fails closed on an unrecognized database claim response", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: [{ outcome: "unexpected" }],
      error: null,
    });

    await expect(
      claimStripeWebhookEvent({
        eventId: "evt_test_1",
        eventType: "customer.created",
        now: NOW,
      }),
    ).rejects.toThrow("stripe_webhook_claim_invalid");
  });
});
