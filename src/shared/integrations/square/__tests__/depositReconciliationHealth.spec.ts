import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  getSquareConfig: vi.fn(),
  getOrder: vi.fn(),
  inventory: {
    data: [] as Record<string, unknown>[] | null,
    error: null as Record<string, unknown> | null,
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock("../client", () => ({
  createPaymentLink: vi.fn(),
  getSquareConfig: mocks.getSquareConfig,
  getOrder: mocks.getOrder,
}));
vi.mock("@/shared/payments/executeBookingPaymentOperation", () => ({
  runAuthoritativeBookingPaymentOperation: vi.fn(),
}));
vi.mock("@/shared/release/v1IntegrationScope", () => ({
  v1AllowsCustomerPaymentGateway: () => true,
}));

import { reconcileDeposits } from "../deposits";

const SALON_ID = "64000000-0000-4000-8000-000000000001";
const BOOKING_ID = "64000000-0000-4000-8000-000000000002";
const OPERATION_ID = "64000000-0000-4000-8000-000000000003";
const REQUEST_ID = "64000000-0000-4000-8000-000000000004";
const ATTEMPT_ID = "64000000-0000-4000-8000-000000000005";
const MATERIAL_FINGERPRINT = "a".repeat(64);
const MERCHANT_ID = "merchant-health-test";
const LOCATION_ID = "location-health-test";
const ACCOUNT_FINGERPRINT = createHash("sha256")
  .update(`square:${MERCHANT_ID}:${LOCATION_ID}:sandbox`, "utf8")
  .digest("hex");

function inventoryQuery() {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    limit: () => Promise.resolve(structuredClone(mocks.inventory)),
  };
  return query;
}

function inventoryRow() {
  return {
    id: OPERATION_ID,
    request_id: REQUEST_ID,
    material_fingerprint: MATERIAL_FINGERPRINT,
  };
}

function claimedOperation() {
  return {
    success: true,
    code: "reconcile_claimed",
    status: "reconciling",
    operation_id: OPERATION_ID,
    booking_id: BOOKING_ID,
    attempt_token: ATTEMPT_ID,
    provider_idempotency_key: `nq:${OPERATION_ID}`,
    provider_order_id: "order-health-test",
    provider_link_id: "link-health-test",
    provider_link_url: "https://square.test/link-health-test",
    material_fingerprint: MATERIAL_FINGERPRINT,
    material: {
      salon_id: SALON_ID,
      booking_id: BOOKING_ID,
      operation_kind: "deposit_charge",
      delivery_mode: "square_hosted_link",
      provider: "square",
      provider_account_fingerprint: ACCOUNT_FINGERPRINT,
      amount_cents: 2_500,
      currency: "CAD",
      hold: false,
    },
    provider_material: {
      provider_account_id: MERCHANT_ID,
      provider_location_id: LOCATION_ID,
      provider_environment: "sandbox",
      amount_cents: 2_500,
      currency: "CAD",
      booking_reference: BOOKING_ID,
      delivery_mode: "square_hosted_link",
    },
  };
}

describe("Square deposit reconciliation health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inventory.data = [];
    mocks.inventory.error = null;
    mocks.from.mockImplementation(() => inventoryQuery());
    mocks.getSquareConfig.mockResolvedValue({
      salonId: SALON_ID,
      merchantId: MERCHANT_ID,
      locationId: LOCATION_ID,
      environment: "sandbox",
      currency: "CAD",
      accessToken: "fake-token",
    });
    mocks.getOrder.mockResolvedValue({
      state: "COMPLETED",
      paidCents: 2_500,
      tenderPaymentId: "payment-health-test",
    });
  });

  it("fails closed when the operation inventory cannot be read", async () => {
    mocks.inventory.error = { code: "42501", message: "private database detail" };

    const result = await reconcileDeposits(SALON_ID);

    expect(result).toEqual({
      ok: false,
      checked: 0,
      paid: 0,
      error: "square_deposit_reconciliation_inventory_unavailable",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });

  it("fails closed when the durable reconciliation claim fails", async () => {
    mocks.inventory.data = [inventoryRow()];
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "40001", message: "private claim detail" },
    });

    const result = await reconcileDeposits(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      checked: 1,
      paid: 0,
      error: "square_deposit_reconciliation_claim_unavailable",
    });
    expect(mocks.getOrder).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private claim detail");
  });

  it("fails closed without leaking a provider transport error", async () => {
    mocks.inventory.data = [inventoryRow()];
    mocks.rpc.mockResolvedValueOnce({ data: claimedOperation(), error: null });
    mocks.getOrder.mockRejectedValue(new Error("private provider transport detail"));

    const result = await reconcileDeposits(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      checked: 1,
      paid: 0,
      error: "square_deposit_reconciliation_provider_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("private provider transport detail");
  });

  it("fails closed when the exact completion receipt cannot be persisted", async () => {
    mocks.inventory.data = [inventoryRow()];
    mocks.rpc
      .mockResolvedValueOnce({ data: claimedOperation(), error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: "40001", message: "private completion detail" },
      });

    const result = await reconcileDeposits(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      checked: 1,
      paid: 0,
      error: "square_deposit_reconciliation_completion_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("private completion detail");
  });

  it("reports success only after the exact provider receipt is persisted", async () => {
    mocks.inventory.data = [inventoryRow()];
    mocks.rpc
      .mockResolvedValueOnce({ data: claimedOperation(), error: null })
      .mockResolvedValueOnce({
        data: { success: true, status: "succeeded", code: "completed" },
        error: null,
      });

    const result = await reconcileDeposits(SALON_ID);

    expect(result).toEqual({ ok: true, checked: 1, paid: 1 });
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_operation_id: OPERATION_ID,
        p_provider_payment_id: "payment-health-test",
        p_outcome: "succeeded",
      }),
    );
  });
});
