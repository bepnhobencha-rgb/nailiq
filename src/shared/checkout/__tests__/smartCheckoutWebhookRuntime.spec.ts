import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

vi.mock("server-only", () => ({}));

import {
  allowsSmartCheckoutSandboxWebhookIngestion,
  sanitizeSquareTerminalCheckoutEvent,
  sanitizeStripeTerminalEvent,
  smartCheckoutProviderAccountFingerprint,
} from "@/shared/checkout/smartCheckoutWebhookRuntime";
import { parseSquareEvent } from "@/shared/integrations/square/webhookRuntime";

const sessionId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";

function squareCheckout(overrides: Record<string, unknown> = {}) {
  return parseSquareEvent(JSON.stringify({
    merchant_id: "merchant-sandbox",
    type: "terminal.checkout.updated",
    event_id: "square-event-1",
    created_at: "2026-08-31T17:00:01Z",
    data: {
      id: "checkout-sandbox-1",
      object: {
        checkout: {
          id: "checkout-sandbox-1",
          app_id: "application-sandbox",
          location_id: "location-sandbox",
          device_options: { device_id: "device-sandbox" },
          reference_id: sessionId,
          status: "COMPLETED",
          amount_money: { amount: 5_350, currency: "CAD" },
          payment_ids: ["payment-sandbox-1"],
          updated_at: "2026-08-31T17:00:00Z",
          note: "Jane +1 604 555 0199 must never survive",
          card: { number: "4242424242424242" },
          ...overrides,
        },
      },
    },
  }));
}

function stripeEvent(overrides: Record<string, unknown> = {}): Stripe.Event {
  return {
    id: "evt_sandbox_1",
    object: "event",
    api_version: null,
    created: 1_788_195_600,
    data: {
      object: {
        id: "pi_sandbox_1",
        object: "payment_intent",
        amount: 5_350,
        currency: "cad",
        livemode: false,
        status: "succeeded",
        payment_method_types: ["card_present"],
        latest_charge: "ch_sandbox_1",
        metadata: {
          nailiq_operation_id: sessionId,
          nailiq_salon_id: salonId,
          nailiq_booking_id: "33333333-3333-4333-8333-333333333333",
          customer_email: "must-not-survive@example.com",
        },
        receipt_email: "must-not-survive@example.com",
        ...overrides,
      } as unknown as Stripe.PaymentIntent,
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "payment_intent.succeeded",
  } as Stripe.Event;
}

describe("Smart Checkout signed webhook runtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires both explicit sandbox ingestion switches", () => {
    vi.stubEnv("SMART_CHECKOUT_SANDBOX_WEBHOOK_INGESTION_ENABLED", "1");
    expect(allowsSmartCheckoutSandboxWebhookIngestion()).toBe(false);
    vi.stubEnv("SMART_CHECKOUT_PROVIDER_ENVIRONMENT", "sandbox");
    expect(allowsSmartCheckoutSandboxWebhookIngestion()).toBe(true);
    vi.stubEnv("SMART_CHECKOUT_PROVIDER_ENVIRONMENT", "production");
    expect(allowsSmartCheckoutSandboxWebhookIngestion()).toBe(false);
  });

  it("uses the migration account-fingerprint contract", () => {
    expect(smartCheckoutProviderAccountFingerprint("stripe", " acct_sandbox ")).toBe(
      createHash("sha256").update("stripe:acct_sandbox").digest("hex"),
    );
  });

  it("normalizes a Square Terminal checkout without raw, card, note, or customer material", () => {
    const event = squareCheckout();
    expect(event).not.toBeNull();
    const material = sanitizeSquareTerminalCheckoutEvent(event!);
    expect(material).toEqual({
      sessionId,
      providerLocationId: "location-sandbox",
      providerDeviceId: "device-sandbox",
      providerCheckoutId: "checkout-sandbox-1",
      providerPaymentId: "payment-sandbox-1",
      providerStatus: "COMPLETED",
      amountCents: 5_350,
      currency: "CAD",
      occurredAt: "2026-08-31T17:00:00Z",
      failureCode: null,
      providerApplicationId: "application-sandbox",
    });
    expect(JSON.stringify(material)).not.toMatch(/Jane|424242|phone|note|card/i);
  });

  it("fails closed on unsupported Square split tender or non-session reference", () => {
    expect(sanitizeSquareTerminalCheckoutEvent(squareCheckout({
      payment_ids: ["payment-1", "payment-2"],
    })!)).toBeNull();
    expect(sanitizeSquareTerminalCheckoutEvent(squareCheckout({
      reference_id: "booking:customer-1",
    })!)).toBeNull();
  });

  it("normalizes sandbox Stripe card-present PaymentIntent truth without metadata PII", () => {
    const material = sanitizeStripeTerminalEvent(stripeEvent());
    expect(material).toEqual({
      sessionId,
      providerLocationId: null,
      providerDeviceId: null,
      providerCheckoutId: "pi_sandbox_1",
      providerPaymentId: "ch_sandbox_1",
      providerStatus: "succeeded",
      amountCents: 5_350,
      currency: "CAD",
      occurredAt: new Date(1_788_195_600 * 1000).toISOString(),
      failureCode: null,
      claimedSalonId: salonId,
    });
    expect(JSON.stringify(material)).not.toMatch(/must-not-survive|receipt_email|booking_id/i);
  });

  it("rejects live-mode or non-card-present Stripe PaymentIntents", () => {
    expect(sanitizeStripeTerminalEvent(stripeEvent({ livemode: true }))).toBeNull();
    expect(sanitizeStripeTerminalEvent(stripeEvent({
      payment_method_types: ["card"],
    }))).toBeNull();
  });

  it("normalizes a Stripe reader failure without retaining the provider message", () => {
    const readerEvent = {
      ...stripeEvent(),
      type: "terminal.reader.action_failed",
      data: {
        object: {
          id: "tmr_sandbox",
          object: "terminal.reader",
          livemode: false,
          location: "tml_sandbox",
          action: {
            type: "process_payment_intent",
            status: "failed",
            failure_code: "card_declined",
            failure_message: "Customer Jane card 4242 was declined",
            process_payment_intent: { payment_intent: "pi_sandbox_1" },
          },
        },
      },
    } as unknown as Stripe.Event;
    const material = sanitizeStripeTerminalEvent(readerEvent);
    expect(material).toMatchObject({
      sessionId: null,
      providerLocationId: "tml_sandbox",
      providerDeviceId: "tmr_sandbox",
      providerCheckoutId: "pi_sandbox_1",
      providerStatus: "failed",
      amountCents: null,
      currency: null,
      failureCode: "card_declined",
    });
    expect(JSON.stringify(material)).not.toMatch(/Customer Jane|4242|failure_message/i);
  });
});
