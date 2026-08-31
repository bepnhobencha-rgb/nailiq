import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createService,
}));

import { POST } from "./route";

const url = "https://nailiq.test/api/webhooks/smart-checkout/square";
const signatureKey = "square-smart-checkout-test-key";
const sessionId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";
const deviceRowId = "33333333-3333-4333-8333-333333333333";
const accountFingerprint = createHash("sha256")
  .update("square:merchant-sandbox")
  .digest("hex");

function chain(result: unknown) {
  const value: Record<string, unknown> = {};
  for (const method of ["select", "eq", "limit"]) value[method] = vi.fn(() => value);
  value.then = (resolve: (result: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return value;
}

function rawBody() {
  return JSON.stringify({
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
          note: "Jane +1 604 555 0199",
          card: { number: "4242424242424242" },
        },
      },
    },
  });
}

function request(raw: string, signature?: string) {
  const valid = createHmac("sha256", signatureKey).update(url).update(raw).digest("base64");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-square-hmacsha256-signature": signature ?? valid,
    },
    body: raw,
  });
}

describe("Square Smart Checkout sandbox webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SMART_CHECKOUT_SANDBOX_WEBHOOK_INGESTION_ENABLED", "1");
    vi.stubEnv("SMART_CHECKOUT_PROVIDER_ENVIRONMENT", "sandbox");
    vi.stubEnv("SQUARE_WEBHOOK_PROFILES_JSON", JSON.stringify([{
      applicationId: "application-sandbox",
      environment: "sandbox",
      notificationUrl: url,
      signatureKey,
    }]));
    mocks.createService.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
    mocks.from.mockImplementation((table: string) => {
      if (table === "square_integrations") return chain({ data: [{
        salon_id: salonId,
        merchant_id: "merchant-sandbox",
        location_id: "location-sandbox",
        application_id: "application-sandbox",
        environment: "sandbox",
      }], error: null });
      if (table === "smart_checkout_sessions") return chain({ data: [{
        id: sessionId,
        salon_id: salonId,
        provider: "square",
        provider_account_fingerprint: accountFingerprint,
        provider_location_id: "location-sandbox",
        device_id: deviceRowId,
        provider_checkout_id: null,
        provider_payment_id: null,
        amount_due_cents: 5_350,
        currency: "CAD",
      }], error: null });
      if (table === "smart_checkout_devices") return chain({ data: [{
        id: deviceRowId,
        salon_id: salonId,
        provider: "square",
        provider_account_fingerprint: accountFingerprint,
        provider_device_id: "device-sandbox",
        provider_location_id: "location-sandbox",
        disabled_at: null,
      }], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "webhook_event_recorded", event_id: "square-event-1" },
      error: null,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed before signature or DB work unless both sandbox gates are explicit", async () => {
    vi.stubEnv("SMART_CHECKOUT_PROVIDER_ENVIRONMENT", "production");
    const response = await POST(request(rawBody()));
    expect(response.status).toBe(503);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature before service-role construction", async () => {
    const response = await POST(request(rawBody(), "bad"));
    expect(response.status).toBe(401);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("binds exact account/location/device/session and stores only normalized scalars", async () => {
    const response = await POST(request(rawBody()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      code: "webhook_event_recorded",
      eventId: "square-event-1",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("record_smart_checkout_webhook_event", {
      p_provider: "square",
      p_salon_id: salonId,
      p_event_id: "square-event-1",
      p_event_type: "terminal.checkout.updated",
      p_occurred_at: "2026-08-31T17:00:00Z",
      p_payload_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      p_provider_account_id: "merchant-sandbox",
      p_provider_location_id: "location-sandbox",
      p_provider_device_id: "device-sandbox",
      p_provider_checkout_id: "checkout-sandbox-1",
      p_provider_payment_id: "payment-sandbox-1",
      p_provider_status: "COMPLETED",
      p_amount_cents: 5_350,
      p_currency: "CAD",
      p_material: { session_id: sessionId },
    });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toMatch(/Jane|604 555|424242|note|card/i);
  });

  it("rejects a signed device mismatch before the inbox RPC", async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === "square_integrations") return chain({ data: [{
        salon_id: salonId,
        merchant_id: "merchant-sandbox",
        location_id: "location-sandbox",
        application_id: "application-sandbox",
        environment: "sandbox",
      }], error: null });
      if (table === "smart_checkout_sessions") return chain({ data: [{
        id: sessionId,
        salon_id: salonId,
        provider: "square",
        provider_account_fingerprint: accountFingerprint,
        provider_location_id: "location-sandbox",
        device_id: deviceRowId,
        provider_checkout_id: null,
        provider_payment_id: null,
        amount_due_cents: 5_350,
        currency: "CAD",
      }], error: null });
      if (table === "smart_checkout_devices") return chain({ data: [{
        id: deviceRowId,
        salon_id: salonId,
        provider: "square",
        provider_account_fingerprint: accountFingerprint,
        provider_device_id: "different-device",
        provider_location_id: "location-sandbox",
        disabled_at: null,
      }], error: null });
      throw new Error(`unexpected table ${table}`);
    });
    const response = await POST(request(rawBody()));
    expect(response.status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
