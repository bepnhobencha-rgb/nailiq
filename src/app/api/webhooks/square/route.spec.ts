import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createService,
}));

import { POST } from "./route";

const url = "https://nailiq.test/api/webhooks/square";
const signatureKey = "square-test-signature-key";
const salonId = "11111111-1111-4111-8111-111111111111";
const secondSalonId = "22222222-2222-4222-8222-222222222222";
const fingerprint = "a".repeat(64);

function integrationChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "limit"]) chain[name] = vi.fn(() => chain);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    merchant_id: "merchant-1",
    type: "loyalty.promotion.updated",
    event_id: "event-1",
    created_at: "2026-08-20T12:00:00Z",
    data: {
      id: "promotion-1",
      object: { loyalty_promotion: { id: "promotion-1", status: "CANCELED" } },
    },
    ...overrides,
  });
}

function refundBody(overrides: Record<string, unknown> = {}) {
  return body({
    type: "refund.updated",
    event_id: "refund-event-1",
    created_at: "2026-08-23T17:00:01Z",
    data: {
      id: "refund-1",
      object: {
        refund: {
          id: "refund-1",
          payment_id: "payment-1",
          location_id: "location-1",
          status: "COMPLETED",
          amount_money: { amount: 1_250, currency: "CAD" },
          updated_at: "2026-08-23T17:00:00Z",
          reason: "must-not-persist",
          destination_details: { card_details: { card: "4111111111111111" } },
          ...overrides,
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

describe("Square webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SQUARE_WEBHOOK_PROFILES_JSON", JSON.stringify([{
      applicationId: "application-1",
      environment: "sandbox",
      notificationUrl: url,
      signatureKey,
    }]));
    mocks.createService.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
    mocks.from.mockImplementation((table: string) => {
      if (table === "square_integrations") {
        return integrationChain({
          data: [{
            salon_id: salonId,
            merchant_id: "merchant-1",
            location_id: "location-1",
            application_id: "application-1",
            environment: "sandbox",
          }],
          error: null,
        });
      }
      throw new Error(`unexpected table ${table}`);
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "square_feature_contract") {
        return {
          data: {
            success: true,
            code: "ready",
            api_version: "2026-07-15",
            salon_id: salonId,
            merchant_id: "merchant-1",
            location_id: "location-1",
            application_id: "application-1",
            environment: "sandbox",
            provider_account_fingerprint: fingerprint,
          },
          error: null,
        };
      }
      if (name === "record_square_webhook_event") {
        return { data: { success: true, code: "event_recorded", event_id: "event-1" }, error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([null, "bad"])("rejects invalid signature before any DB access", async (signature) => {
    const response = await POST(request(body(), signature ?? ""));
    expect(response.status).toBe(401);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before any DB access", async () => {
    const raw = "x".repeat(256 * 1024 + 1);
    const response = await POST(request(raw));
    expect(response.status).toBe(413);
    expect(mocks.createService).not.toHaveBeenCalled();
  });

  it("routes application/environment/merchant, strips PII, and records promotion event", async () => {
    const raw = body({
      data: {
        id: "promotion-1",
        object: {
          loyalty_promotion: {
            id: "promotion-1",
            status: "CANCELED",
            customer_id: "must-not-persist",
            mapping: { phone_number: "+16045550199" },
          },
        },
      },
    });
    const response = await POST(request(raw));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, code: "event_recorded" });
    expect(mocks.rpc).toHaveBeenCalledWith("record_square_webhook_event", expect.objectContaining({
      p_salon_id: salonId,
      p_event_id: "event-1",
      p_event_type: "loyalty.promotion.updated",
      p_entity_id: "promotion-1",
      p_material: expect.objectContaining({
        application_id: "application-1",
        environment: "sandbox",
        merchant_id: "merchant-1",
        api_version: "2026-07-15",
        provider_account_fingerprint: fingerprint,
      }),
    }));
    const serialized = JSON.stringify(mocks.rpc.mock.calls);
    expect(serialized).not.toContain("must-not-persist");
    expect(serialized).not.toContain("16045550199");
  });

  it("binds refund.updated to the exact tenant/account operation without raw or PII material", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        success: true,
        code: "refund_applied",
        event_id: "refund-event-1",
      },
      error: null,
    });

    const response = await POST(request(refundBody()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      code: "refund_applied",
      eventId: "refund-event-1",
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_square_refund_webhook_event",
      {
        p_salon_id: salonId,
        p_event_id: "refund-event-1",
        p_occurred_at: "2026-08-23T17:00:01Z",
        p_payload_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        p_provider_refund_id: "refund-1",
        p_parent_payment_id: "payment-1",
        p_location_id: "location-1",
        p_provider_status: "COMPLETED",
        p_amount_cents: 1_250,
        p_currency: "CAD",
        p_refund_updated_at: "2026-08-23T17:00:00Z",
        p_merchant_id: "merchant-1",
        p_application_id: "application-1",
        p_environment: "sandbox",
      },
    );
    const serialized = JSON.stringify(mocks.rpc.mock.calls);
    expect(serialized).not.toContain("must-not-persist");
    expect(serialized).not.toContain("4111111111111111");
  });

  it("routes a shared-merchant refund to the exact Square location tenant", async () => {
    const chain = integrationChain({
      data: [{
        salon_id: secondSalonId,
        merchant_id: "merchant-1",
        location_id: "location-2",
        application_id: "application-1",
        environment: "sandbox",
      }],
      error: null,
    });
    mocks.from.mockReturnValue(chain);
    mocks.rpc.mockResolvedValue({
      data: {
        success: true,
        code: "refund_applied",
        event_id: "refund-event-1",
      },
      error: null,
    });

    const response = await POST(request(refundBody({ location_id: "location-2" })));

    expect(response.status).toBe(200);
    expect(chain.eq).toHaveBeenCalledWith("location_id", "location-2");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_square_refund_webhook_event",
      expect.objectContaining({
        p_salon_id: secondSalonId,
        p_location_id: "location-2",
      }),
    );
  });

  it("fails closed for merchant-wide events when one merchant maps to multiple salons", async () => {
    mocks.from.mockReturnValue(integrationChain({
      data: [
        {
          salon_id: salonId,
          merchant_id: "merchant-1",
          location_id: "location-1",
          application_id: "application-1",
          environment: "sandbox",
        },
        {
          salon_id: secondSalonId,
          merchant_id: "merchant-1",
          location_id: "location-2",
          application_id: "application-1",
          environment: "sandbox",
        },
      ],
      error: null,
    }));

    const response = await POST(request(body()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "provider_context_mismatch",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a refund location mismatch before the financial inbox RPC", async () => {
    const response = await POST(request(refundBody({ location_id: "location-hostile" })));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "provider_context_mismatch",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["event_replay", true, 200],
    ["refund_terminal_noop", true, 200],
    ["stale_event_ignored", true, 200],
    ["event_conflict", false, 409],
    ["provider_binding_mismatch", false, 409],
    ["terminal_state_conflict", false, 409],
    ["operation_not_found", false, 503],
  ] as const)("maps refund ingestion result %s truthfully", async (code, success, status) => {
    mocks.rpc.mockResolvedValue({
      data: { success, code, event_id: "refund-event-1" },
      error: null,
    });
    const response = await POST(request(refundBody()));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
  });

  it("fails closed when the refund inbox write result is uncertain", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "write uncertain" } });
    const response = await POST(request(refundBody()));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "webhook_store_unavailable",
    });
  });

  it("accepts Square's current dispute state event", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    mocks.from.mockImplementation((table: string) => {
      if (table === "square_integrations") {
        return integrationChain({
          data: [{
            salon_id: salonId,
            merchant_id: "merchant-1",
            location_id: "location-1",
            application_id: "application-1",
            environment: "sandbox",
          }],
          error: null,
        });
      }
      if (table === "payment_disputes") return { upsert };
      throw new Error(`unexpected table ${table}`);
    });
    const raw = body({
      type: "dispute.state.updated",
      data: {
        id: "dispute-1",
        object: {
          dispute: {
            id: "dispute-1",
            state: "WON",
            amount_money: { amount: 2_500, currency: "CAD" },
          },
        },
      },
    });

    const response = await POST(request(raw));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      code: "dispute_recorded",
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        provider_dispute_id: "dispute-1",
        amount_cents: 2_500,
        currency: "CAD",
        status: "WON",
      }),
      { onConflict: "provider_dispute_id" },
    );
  });

  it.each([
    ["event_replay", true, 200],
    ["event_conflict", false, 409],
  ] as const)("maps exact %s truthfully", async (code, success, status) => {
    mocks.rpc.mockImplementation(async (name: string) => name === "square_feature_contract"
      ? {
          data: {
            success: true,
            code: "ready",
            api_version: "2026-07-15",
            salon_id: salonId,
            merchant_id: "merchant-1",
            location_id: "location-1",
            application_id: "application-1",
            environment: "sandbox",
            provider_account_fingerprint: fingerprint,
          },
          error: null,
        }
      : { data: { success, code, event_id: "event-1" }, error: null });
    const response = await POST(request(body()));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
  });

  it("rejects merchant/account mismatch without inbox RPC", async () => {
    mocks.from.mockReturnValue(integrationChain({ data: [], error: null }));
    const response = await POST(request(body()));
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
