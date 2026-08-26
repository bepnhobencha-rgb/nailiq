import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  retrieve: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: () => ({ paymentIntents: { retrieve: mocks.retrieve } }),
}));

import { POST } from "./route";

const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const ROTATED_REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const ATTEMPT_TOKEN = "66666666-6666-4666-8666-666666666666";
const SALON_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "77777777-7777-4777-8777-777777777777";
const STAFF_ID = "88888888-8888-4888-8888-888888888888";
const BOOKING_REQUEST_ID = "99999999-9999-4999-8999-999999999999";
const FP = "a".repeat(64);
const TOKEN = "finalize-token-bound-to-operation-and-request";

function request(
  paymentRequestId = REQUEST_ID,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) {
  return new Request("https://nailiq.test/api/booking/deposit-finalize", {
    method: "POST",
    headers: {
      Origin: "https://nailiq.test",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      operationId: OPERATION_ID,
      paymentRequestId,
      finalizeToken: TOKEN,
      ...extra,
    }),
  });
}

function material() {
  return {
    salon_id: SALON_ID,
    service_id: SERVICE_ID,
    staff_id: STAFF_ID,
    start_time_utc: "2026-08-28T18:00:00.000Z",
    end_time_utc: "2026-08-28T19:00:00.000Z",
    booking_idempotency_key: BOOKING_REQUEST_ID,
    pricing_fingerprint: FP,
    client_phone_fingerprint: "b".repeat(64),
    operation_kind: "deposit_charge",
    provider: "stripe",
    provider_account_fingerprint:
      "fd8fff6944dcc38d42d1561888d7001df7cd1834449ffee4ec7c96aeba5fb177",
    amount_cents: 250_000,
    currency: "VND",
    deposit_reason: "new_customer",
    provider_material: {
      provider: "stripe",
      provider_account_id: "acct_qa",
      provider_location_id: null,
      provider_application_id: null,
      provider_environment: null,
      currency: "VND",
      amount_cents: 250_000,
      booking_intent_reference: BOOKING_REQUEST_ID,
      pricing_fingerprint: FP,
    },
  };
}

describe("POST /api/booking/deposit-finalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails a rotated payment request closed before provider reconciliation", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_public_deposit_finalization") {
        return { data: { success: false, code: "operation_not_found" }, error: null };
      }
      return { data: null, error: { message: "unexpected rpc" } };
    });

    const response = await POST(request(ROTATED_REQUEST_ID));
    expect(response.status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledWith("claim_public_deposit_finalization", {
      p_operation_id: OPERATION_ID,
      p_request_id: ROTATED_REQUEST_ID,
      p_finalize_token: TOKEN,
    });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(([name]) => name))
      .not.toContain("complete_booking_payment_operation");
  });

  it("returns exact terminal replay without retrieving or redispatching provider work", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_public_deposit_finalization") return {
        data: {
          success: true,
          code: "operation_replay",
          status: "succeeded",
          operation_id: OPERATION_ID,
          material_fingerprint: FP,
        },
        error: null,
      };
      return { data: null, error: { message: "unexpected rpc" } };
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      code: "succeeded",
      operationId: OPERATION_ID,
      materialFingerprint: FP,
    });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("retrieves the DB-owned provider receipt and completes before reporting paid", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_public_deposit_finalization") return {
        data: {
          success: true,
          code: "finalization_claimed",
          status: "reconciling",
          operation_id: OPERATION_ID,
          attempt_token: ATTEMPT_TOKEN,
          provider_payment_id: "pi_123456",
          material_fingerprint: FP,
          material: material(),
        },
        error: null,
      };
      if (name === "complete_booking_payment_operation") return {
        data: { success: true, code: "succeeded" },
        error: null,
      };
      return { data: null, error: { message: "unexpected rpc" } };
    });
    mocks.retrieve.mockResolvedValue({ id: "pi_123456", status: "succeeded" });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith(
      "pi_123456",
      {},
      { stripeAccount: "acct_qa" },
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_operation_id: OPERATION_ID,
        p_attempt_token: ATTEMPT_TOKEN,
        p_outcome: "succeeded",
        p_provider_payment_id: "pi_123456",
      }),
    );
    expect(await response.json()).toMatchObject({ ok: true, code: "succeeded" });
  });

  it("records a provider retrieval outage as unknown and never reports the deposit paid", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_public_deposit_finalization") return {
        data: {
          success: true,
          code: "finalization_claimed",
          status: "reconciling",
          operation_id: OPERATION_ID,
          attempt_token: ATTEMPT_TOKEN,
          provider_payment_id: "pi_outage",
          material_fingerprint: FP,
          material: material(),
        },
        error: null,
      };
      if (name === "complete_booking_payment_operation") return {
        data: { success: false, code: "provider_outcome_unknown" },
        error: null,
      };
      return { data: null, error: { message: "unexpected rpc" } };
    });
    mocks.retrieve.mockRejectedValue(new Error("provider unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: "provider_outcome_unknown" });
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_operation_id: OPERATION_ID,
        p_attempt_token: ATTEMPT_TOKEN,
        p_outcome: "unknown",
        p_provider_payment_id: "pi_outage",
        p_error_code: "provider_transport_error",
      }),
    );
  });

  it("does zero provider work when an ordinary retry has no reconciliation lease", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_public_deposit_finalization") return {
        data: {
          success: false,
          code: "finalization_not_available",
          status: "unknown",
          operation_id: OPERATION_ID,
        },
        error: null,
      };
      return { data: null, error: { message: "unexpected rpc" } };
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: "finalization_not_available" });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(([name]) => name))
      .not.toContain("complete_booking_payment_operation");
  });
});
