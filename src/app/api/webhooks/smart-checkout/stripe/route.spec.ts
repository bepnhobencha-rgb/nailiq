import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  getStripeClient: vi.fn(),
  constructEvent: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createService,
}));
vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: mocks.getStripeClient,
}));

import { POST } from "./route";

const url = "https://nailiq.test/api/webhooks/smart-checkout/stripe";
const sessionId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";
const deviceRowId = "33333333-3333-4333-8333-333333333333";
const accountFingerprint = createHash("sha256")
  .update("stripe:acct_sandbox")
  .digest("hex");

function chain(result: unknown) {
  const value: Record<string, unknown> = {};
  for (const method of ["select", "eq", "limit"]) value[method] = vi.fn(() => value);
  value.then = (resolve: (result: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return value;
}

function event(): Stripe.Event {
  return {
    id: "evt_sandbox_1",
    object: "event",
    account: "acct_sandbox",
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
          customer_phone: "+16045550199",
        },
        receipt_email: "must-not-survive@example.com",
      } as unknown as Stripe.PaymentIntent,
    },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "payment_intent.succeeded",
  } as Stripe.Event;
}

function readerEvent(): Stripe.Event {
  return {
    ...event(),
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
}

function request(raw = '{ "raw": "bytes stay exact" }', signature = "stripe-test-signature") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: raw,
  });
}

describe("Stripe Smart Checkout sandbox webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SMART_CHECKOUT_SANDBOX_WEBHOOK_INGESTION_ENABLED", "1");
    vi.stubEnv("SMART_CHECKOUT_PROVIDER_ENVIRONMENT", "sandbox");
    vi.stubEnv("STRIPE_SMART_CHECKOUT_WEBHOOK_SECRET", "whsec_smart_checkout_test");
    mocks.getStripeClient.mockReturnValue({ webhooks: { constructEvent: mocks.constructEvent } });
    mocks.constructEvent.mockReturnValue(event());
    mocks.createService.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
    mocks.from.mockImplementation((table: string) => {
      if (table === "salons") return chain({ data: [{
        id: salonId,
        stripe_connect_account_id: "acct_sandbox",
        payment_provider: "stripe",
      }], error: null });
      if (table === "smart_checkout_sessions") return chain({ data: [{
        id: sessionId,
        salon_id: salonId,
        provider: "stripe",
        provider_account_fingerprint: accountFingerprint,
        provider_location_id: "tml_sandbox",
        device_id: deviceRowId,
        provider_checkout_id: null,
        provider_payment_id: null,
        amount_due_cents: 5_350,
        currency: "CAD",
      }], error: null });
      if (table === "smart_checkout_devices") return chain({ data: [{
        id: deviceRowId,
        salon_id: salonId,
        provider: "stripe",
        provider_account_fingerprint: accountFingerprint,
        provider_device_id: "tmr_sandbox",
        provider_location_id: "tml_sandbox",
        disabled_at: null,
      }], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "webhook_event_recorded", event_id: "evt_sandbox_1" },
      error: null,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed before Stripe or DB construction when sandbox ingestion is disabled", async () => {
    vi.stubEnv("SMART_CHECKOUT_SANDBOX_WEBHOOK_INGESTION_ENABLED", "0");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.getStripeClient).not.toHaveBeenCalled();
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("verifies the exact raw body and rejects before DB access on signature failure", async () => {
    mocks.constructEvent.mockImplementation(() => { throw new Error("bad signature"); });
    const raw = '{ "spacing": "must remain exact" }';
    const response = await POST(request(raw));
    expect(response.status).toBe(401);
    expect(mocks.constructEvent).toHaveBeenCalledWith(
      raw,
      "stripe-test-signature",
      "whsec_smart_checkout_test",
    );
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("binds exact connected account/session/device and stores PII-free scalars", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      code: "webhook_event_recorded",
      eventId: "evt_sandbox_1",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("record_smart_checkout_webhook_event", {
      p_provider: "stripe",
      p_salon_id: salonId,
      p_event_id: "evt_sandbox_1",
      p_event_type: "payment_intent.succeeded",
      p_occurred_at: new Date(1_788_195_600 * 1000).toISOString(),
      p_payload_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_provider_account_id: "acct_sandbox",
      p_provider_location_id: "tml_sandbox",
      p_provider_device_id: "tmr_sandbox",
      p_provider_checkout_id: "pi_sandbox_1",
      p_provider_payment_id: "ch_sandbox_1",
      p_provider_status: "succeeded",
      p_amount_cents: 5_350,
      p_currency: "CAD",
      p_material: { session_id: sessionId },
    });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toMatch(
      /must-not-survive|customer_phone|16045550199|receipt_email/i,
    );
  });

  it("rejects a signed event for a different connected account", async () => {
    mocks.constructEvent.mockReturnValue({ ...event(), account: "acct_other" });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reconciles a reader action through the existing PaymentIntent session binding", async () => {
    mocks.constructEvent.mockReturnValue(readerEvent());
    mocks.from.mockImplementation((table: string) => {
      if (table === "salons") return chain({ data: [{
        id: salonId,
        stripe_connect_account_id: "acct_sandbox",
        payment_provider: "stripe",
      }], error: null });
      if (table === "smart_checkout_sessions") return chain({ data: [{
        id: sessionId,
        salon_id: salonId,
        provider: "stripe",
        provider_account_fingerprint: accountFingerprint,
        provider_location_id: "tml_sandbox",
        device_id: deviceRowId,
        provider_checkout_id: "pi_sandbox_1",
        provider_payment_id: null,
        amount_due_cents: 5_350,
        currency: "CAD",
      }], error: null });
      if (table === "smart_checkout_devices") return chain({ data: [{
        id: deviceRowId,
        salon_id: salonId,
        provider: "stripe",
        provider_account_fingerprint: accountFingerprint,
        provider_device_id: "tmr_sandbox",
        provider_location_id: "tml_sandbox",
        disabled_at: null,
      }], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "webhook_event_recorded", event_id: "evt_sandbox_1" },
      error: null,
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_smart_checkout_webhook_event",
      expect.objectContaining({
        p_event_type: "terminal.reader.action_failed",
        p_provider_checkout_id: "pi_sandbox_1",
        p_provider_device_id: "tmr_sandbox",
        p_amount_cents: 5_350,
        p_currency: "CAD",
        p_material: { session_id: sessionId, failure_code: "card_declined" },
      }),
    );
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toMatch(/Customer Jane|4242|failure_message/i);
  });
});
