import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  dispatch: vi.fn(),
  runTrackedCron: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/cronAuthorization", () => ({
  requireCronAuthorization: () => null,
}));
vi.mock("@/shared/security/cronRunHistory", () => ({
  runTrackedCron: mocks.runTrackedCron,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/payments/executeBookingPaymentOperation", () => ({
  dispatchClaimedBookingPaymentOperation: mocks.dispatch,
}));

import { GET } from "./route";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_TOKEN = "44444444-4444-4444-8444-444444444444";
const SALON_ID = "55555555-5555-4555-8555-555555555555";
const MATERIAL_FP = "a".repeat(64);
const ACCOUNT_FP =
  "1e59e91d89464f41b8479bad2bfe3128cbca2b91f536216d1104011941aa2442";

function material() {
  return {
    salon_id: SALON_ID,
    booking_id: null,
    operation_kind: "deposit_refund",
    parent_operation_id: PARENT_ID,
    provider: "stripe",
    provider_account_fingerprint: ACCOUNT_FP,
    amount_cents: 2_000,
    currency: "CAD",
    parent_payment_id: "pi_parent123",
    captured_cents: 2_000,
    refunded_cents: 0,
    reserved_cents: 0,
    remaining_refundable_cents: 2_000,
    provider_material: {
      provider: "stripe",
      provider_account_id: "acct_1",
      provider_location_id: null,
      provider_environment: null,
      currency: "CAD",
      parent_payment_id: "pi_parent123",
    },
  };
}

function request() {
  return new NextRequest("https://nailiq.test/api/cron/deposit-compensation");
}

describe("GET /api/cron/deposit-compensation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PAYMENT_LEDGER_WORKERS_ENABLED", "true");
    mocks.runTrackedCron.mockImplementation(
      (_name: string, callback: () => Promise<Response>) => callback(),
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  it("stays hard-off without recording a healthy run or reading payment state", async () => {
    vi.stubEnv("PAYMENT_LEDGER_WORKERS_ENABLED", "false");

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, code: "disabled", processed: 0 });
    expect(mocks.runTrackedCron).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("fails closed when durable discovery is unavailable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "db unavailable" } });

    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("leases and dispatches one exact paid-unbound compensation operation", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "discover_due_unbound_deposit_compensations") return {
        data: [{
          success: true,
          code: "compensation_due",
          parent_operation_id: PARENT_ID,
          lease_token: LEASE_TOKEN,
          material_fingerprint: MATERIAL_FP,
          material: material(),
        }],
        error: null,
      };
      if (name === "claim_due_unbound_deposit_refund") return {
        data: {
          success: true,
          code: "claimed",
          status: "sending",
          operation_id: OPERATION_ID,
          attempt_token: ATTEMPT_TOKEN,
          provider_idempotency_key: `nq:${OPERATION_ID}`,
          lease_expires_at: "2026-08-20T20:00:00.000Z",
          attempt_count: 1,
          material_fingerprint: MATERIAL_FP,
          material: material(),
        },
        error: null,
      };
      return { data: null, error: { message: "unexpected rpc" } };
    });
    mocks.dispatch.mockResolvedValue({ ok: true, status: "succeeded" });

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_due_unbound_deposit_refund",
      {
        p_parent_operation_id: PARENT_ID,
        p_lease_token: LEASE_TOKEN,
        p_expected_material_fingerprint: MATERIAL_FP,
      },
    );
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({
      ok: true,
      processed: 1,
      refunded: 1,
      unresolved: 0,
    });
  });

  it("returns 503 so the heartbeat is failed when any compensation is unresolved", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ success: true, code: "compensation_due" }],
      error: null,
    });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "compensation_incomplete",
      processed: 0,
      refunded: 0,
      unresolved: 1,
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("reports mixed success as incomplete instead of a healthy heartbeat", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "discover_due_unbound_deposit_compensations") return {
        data: [
          {
            success: true,
            code: "compensation_due",
            parent_operation_id: PARENT_ID,
            lease_token: LEASE_TOKEN,
            material_fingerprint: MATERIAL_FP,
            material: material(),
          },
          { success: true, code: "compensation_due" },
        ],
        error: null,
      };
      if (name === "claim_due_unbound_deposit_refund") return {
        data: {
          success: true,
          code: "claimed",
          status: "sending",
          operation_id: OPERATION_ID,
          attempt_token: ATTEMPT_TOKEN,
          provider_idempotency_key: `nq:${OPERATION_ID}`,
          lease_expires_at: "2026-08-20T20:00:00.000Z",
          attempt_count: 1,
          material_fingerprint: MATERIAL_FP,
          material: material(),
        },
        error: null,
      };
      return { data: null, error: { message: "unexpected rpc" } };
    });
    mocks.dispatch.mockResolvedValue({ ok: true, status: "succeeded" });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "compensation_incomplete",
      processed: 1,
      refunded: 1,
      unresolved: 1,
    });
  });
});
