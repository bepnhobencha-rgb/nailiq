import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getSquareConfig: vi.fn(),
  getOrder: vi.fn(),
  inventory: {
    data: [] as Record<string, unknown>[] | null,
    error: null as Record<string, unknown> | null,
  },
  update: {
    data: null as Record<string, unknown> | null,
    error: null as Record<string, unknown> | null,
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("../looseDb", () => ({
  looseServiceClient: () => ({ from: mocks.from }),
}));
vi.mock("../client", () => ({
  createPaymentLink: vi.fn(),
  getOrder: mocks.getOrder,
  getSquareConfig: mocks.getSquareConfig,
}));
vi.mock("@/shared/integrations/payments", () => ({
  resolvePaymentProvider: vi.fn(),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: vi.fn(),
}));
vi.mock("@/shared/payments/executeBookingPaymentOperation", () => ({
  runAuthoritativeBookingPaymentOperation: vi.fn(),
  runAuthoritativeLateCancelRefund: vi.fn(),
}));
vi.mock("@/shared/release/v1IntegrationScope", () => ({
  v1AllowsCustomerPaymentGateway: () => true,
}));

import { reconcileNoShowFeeLinks } from "../noshow";

const SALON_ID = "65000000-0000-4000-8000-000000000001";
const BOOKING_ID = "65000000-0000-4000-8000-000000000002";

function inventoryQuery() {
  const query = {
    select: () => query,
    eq: () => query,
    not: () => query,
    then: <TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(structuredClone(mocks.inventory)).then(onfulfilled, onrejected),
  };
  return query;
}

function updateQuery() {
  const eq = vi.fn();
  const query = {
    update: () => query,
    eq,
    select: () => query,
    maybeSingle: () => Promise.resolve(structuredClone(mocks.update)),
  };
  eq.mockImplementation(() => query);
  return query;
}

function inventoryRow() {
  return {
    id: BOOKING_ID,
    noshow_fee_cents: 2_500,
    noshow_fee_order_id: "order-noshow-health-test",
    noshow_charge_status: "link_created",
  };
}

describe("Square no-show fee reconciliation health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inventory.data = [];
    mocks.inventory.error = null;
    mocks.update.data = { id: BOOKING_ID };
    mocks.update.error = null;
    mocks.from.mockImplementation(() => inventoryQuery());
    mocks.getSquareConfig.mockResolvedValue({
      salonId: SALON_ID,
      merchantId: "merchant-health-test",
      locationId: "location-health-test",
      environment: "sandbox",
      currency: "CAD",
      accessToken: "fake-token",
    });
    mocks.getOrder.mockResolvedValue({
      state: "COMPLETED",
      paidCents: 2_500,
      tenderPaymentId: "payment-noshow-health-test",
    });
  });

  it("fails closed when the no-show inventory query fails", async () => {
    mocks.inventory.error = { code: "42501", message: "private database detail" };

    const result = await reconcileNoShowFeeLinks(SALON_ID);

    expect(result).toEqual({
      ok: false,
      checked: 0,
      paid: 0,
      error: "square_noshow_reconciliation_inventory_unavailable",
    });
    expect(mocks.getSquareConfig).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });

  it("fails closed without logging or returning a provider transport error", async () => {
    mocks.inventory.data = [inventoryRow()];
    mocks.getOrder.mockRejectedValue(new Error("private provider transport detail"));

    const result = await reconcileNoShowFeeLinks(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      checked: 1,
      paid: 0,
      error: "square_noshow_reconciliation_provider_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("private provider transport detail");
  });

  it("does not mark a completed order paid without the exact amount and tender receipt", async () => {
    mocks.inventory.data = [inventoryRow()];
    mocks.getOrder.mockResolvedValue({
      state: "COMPLETED",
      paidCents: 2_499,
      tenderPaymentId: null,
    });

    const result = await reconcileNoShowFeeLinks(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      paid: 0,
      error: "square_noshow_reconciliation_provider_receipt_invalid",
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the exact tenant-scoped paid write cannot be verified", async () => {
    mocks.inventory.data = [inventoryRow()];
    mocks.update.error = { code: "42501", message: "private write detail" };
    const update = updateQuery();
    mocks.from
      .mockImplementationOnce(() => inventoryQuery())
      .mockImplementationOnce(() => update);

    const result = await reconcileNoShowFeeLinks(SALON_ID);

    expect(result).toMatchObject({
      ok: false,
      paid: 0,
      error: "square_noshow_reconciliation_write_unavailable",
    });
    expect(update.eq).toHaveBeenCalledWith("id", BOOKING_ID);
    expect(update.eq).toHaveBeenCalledWith("salon_id", SALON_ID);
    expect(JSON.stringify(result)).not.toContain("private write detail");
  });

  it("reports success only after verifying the exact tenant-scoped paid write", async () => {
    mocks.inventory.data = [inventoryRow()];
    const update = updateQuery();
    mocks.from
      .mockImplementationOnce(() => inventoryQuery())
      .mockImplementationOnce(() => update);

    const result = await reconcileNoShowFeeLinks(SALON_ID);

    expect(result).toEqual({ ok: true, checked: 1, paid: 1 });
    expect(update.eq).toHaveBeenCalledWith("id", BOOKING_ID);
    expect(update.eq).toHaveBeenCalledWith("salon_id", SALON_ID);
  });
});
