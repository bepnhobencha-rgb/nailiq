import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  parseMaterial: vi.fn(),
  parseClaim: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/payments/bookingPaymentOperations", () => ({
  parseBookingPaymentOperationMaterial: mocks.parseMaterial,
  parseClaimedBookingPaymentOperation: mocks.parseClaim,
}));
vi.mock("@/shared/payments/executeBookingPaymentOperation", () => ({
  dispatchClaimedBookingPaymentOperation: mocks.dispatch,
}));

import { POST } from "./route";

const SALON = "123e4567-e89b-42d3-a456-426614174000";
const SERVICE = "223e4567-e89b-42d3-a456-426614174000";
const STAFF = "323e4567-e89b-42d3-a456-426614174000";
const CREATE_KEY = "423e4567-e89b-42d3-a456-426614174000";
const PAYMENT_OP = "523e4567-e89b-42d3-a456-426614174000";
const PAYMENT_REQUEST = "623e4567-e89b-42d3-a456-426614174000";
const HASH = "a".repeat(64);

function request(origin = "https://nailiq.test") {
  return new Request("https://nailiq.test/api/booking/deposit-create", {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": origin === "https://nailiq.test" ? "same-origin" : "cross-site",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      salonId: SALON,
      serviceId: SERVICE,
      staffId: STAFF,
      clientName: "QA Guest",
      clientPhone: "16045550199",
      startTimeUtc: "2026-08-28T18:00:00.000Z",
      endTimeUtc: "2026-08-28T19:00:00.000Z",
      clientNotes: null,
      addonServiceIds: [],
      clientEmail: "qa@example.test",
      resourceId: null,
      comboId: null,
      voucherId: null,
      applyEmailDiscount: false,
      idempotencyKey: CREATE_KEY,
      pricingFingerprint: HASH,
      paymentOperationId: PAYMENT_OP,
      paymentRequestId: PAYMENT_REQUEST,
      paymentMaterialFingerprint: HASH,
    }),
  });
}

describe("POST /api/booking/deposit-create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockImplementation(async (name: string) => name === "rate_limit_hit"
      ? { data: true, error: null }
      : { data: null, error: { message: `unexpected ${name}` } });
  });

  it("denies cross-origin before service-role or provider work", async () => {
    const response = await POST(request("https://attacker.example"));
    expect(response.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("returns only the canonical nested booking receipt after atomic create+bind", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "create_public_booking_with_deposit_payment") return {
        data: {
          success: true,
          code: "booked_and_deposit_bound",
          idempotent: false,
          booking_id: CREATE_KEY,
          provider_material: { must_not_leak: true },
          booking: { success: true, code: "booked", booking_id: CREATE_KEY },
        },
        error: null,
      };
      throw new Error(`unexpected ${name}`);
    });

    const response = await POST(request());
    const value = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(value.booking_id).toBe(CREATE_KEY);
    expect(value).not.toHaveProperty("provider_material");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("claims and dispatches one exact refund before returning a terminal create failure", async () => {
    const material = {
      bookingId: null,
      parentOperationId: PAYMENT_OP,
      materialFingerprint: HASH,
    };
    const claim = { operationId: CREATE_KEY };
    mocks.parseMaterial.mockReturnValue(material);
    mocks.parseClaim.mockReturnValue(claim);
    mocks.dispatch.mockResolvedValue({
      ok: true,
      status: "succeeded",
      operationId: CREATE_KEY,
      providerReceipt: "refund_receipt",
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "create_public_booking_with_deposit_payment") return {
        data: {
          success: false,
          code: "booking_create_failed",
          booking: { success: false, code: "slot_conflict" },
        },
        error: null,
      };
      if (name === "load_unbound_deposit_refund_material") return {
        data: { success: true, code: "material_loaded", material_fingerprint: HASH, material: {} },
        error: null,
      };
      if (name === "claim_unbound_deposit_refund") return {
        data: { success: true, code: "claimed" },
        error: null,
      };
      throw new Error(`unexpected ${name}`);
    });

    const response = await POST(request());
    const value = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(value.deposit_compensation_status).toBe("succeeded");
    expect(mocks.rpc).toHaveBeenCalledWith("claim_unbound_deposit_refund", {
      p_parent_operation_id: PAYMENT_OP,
      p_request_id: PAYMENT_REQUEST,
      p_expected_material_fingerprint: HASH,
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("returns compensation pending when the first refund dispatch is not durably succeeded", async () => {
    mocks.parseMaterial.mockReturnValue({
      bookingId: null,
      parentOperationId: PAYMENT_OP,
      materialFingerprint: HASH,
    });
    mocks.parseClaim.mockReturnValue({ operationId: CREATE_KEY });
    mocks.dispatch.mockResolvedValue({
      ok: false,
      status: "unknown",
      operationId: CREATE_KEY,
      reason: "provider outcome unknown",
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "create_public_booking_with_deposit_payment") return {
        data: {
          success: false,
          code: "booking_create_failed",
          booking: { success: false, code: "slot_conflict" },
        },
        error: null,
      };
      if (name === "load_unbound_deposit_refund_material") return {
        data: { success: true, code: "material_loaded", material_fingerprint: HASH, material: {} },
        error: null,
      };
      if (name === "claim_unbound_deposit_refund") return {
        data: { success: true, code: "claimed" },
        error: null,
      };
      throw new Error(`unexpected ${name}`);
    });

    const response = await POST(request());
    const value = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(503);
    expect(value).toEqual({
      success: false,
      code: "deposit_compensation_pending",
      bookingCommitted: false,
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("returns terminal create failure after a durable compensation replay without redispatch", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "create_public_booking_with_deposit_payment") return {
        data: {
          success: false,
          code: "booking_create_failed",
          booking: { success: false, code: "slot_conflict" },
        },
        error: null,
      };
      if (name === "load_unbound_deposit_refund_material") return {
        data: { success: true, code: "compensation_replay" },
        error: null,
      };
      throw new Error(`unexpected ${name}`);
    });

    const response = await POST(request());
    const value = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(409);
    expect(value.deposit_compensation_status).toBe("succeeded");
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "claim_unbound_deposit_refund",
      expect.anything(),
    );
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
