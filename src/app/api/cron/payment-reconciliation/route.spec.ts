import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  runTrackedCron: vi.fn(),
}));

vi.mock("@/shared/security/cronAuthorization", () => ({
  requireCronAuthorization: () => null,
}));
vi.mock("@/shared/security/cronRunHistory", () => ({
  runTrackedCron: mocks.runTrackedCron,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/lib/stripe", () => ({ getStripeClient: () => null }));
vi.mock("@/shared/payments/bookingPaymentOperations", () => ({
  parseBookingPaymentOperationMaterial: () => null,
  parseClaimedBookingPaymentOperation: () => null,
  parsePublicDepositPaymentMaterial: () => null,
}));
vi.mock("@/shared/payments/executeBookingPaymentOperation", () => ({
  dispatchClaimedBookingPaymentOperation: vi.fn(),
}));
vi.mock("@/shared/payments/publicDepositFinalizeCapability", () => ({
  derivePublicDepositFinalizeToken: () => "unused",
}));
vi.mock("@/shared/payments/providerMinorUnits", () => ({
  toProviderMinorAmount: (value: number) => value,
}));
vi.mock("@/shared/integrations/square/deposits", () => ({
  reconcileSquareHostedDepositClaim: vi.fn(),
}));
vi.mock("@/shared/integrations/square/publicDepositReconciliation", () => ({
  reconcileSquarePublicDepositResponseLoss: vi.fn(),
}));

import { GET } from "./route";

function request() {
  return new NextRequest("https://nailiq.test/api/cron/payment-reconciliation");
}

describe("GET /api/cron/payment-reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PAYMENT_LEDGER_WORKERS_ENABLED", "true");
    vi.stubEnv("SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT", "");
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
  });

  it("records a healthy empty enabled batch", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      processed: 0,
      succeeded: 0,
      unresolved: 0,
    });
    expect(mocks.runTrackedCron).toHaveBeenCalledTimes(1);
  });

  it("returns 503 so the heartbeat is failed when any operation is unresolved", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ operation_kind: "unrecognized_financial_operation" }],
      error: null,
    });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "reconciliation_incomplete",
      processed: 1,
      succeeded: 0,
      unresolved: 1,
    });
  });
});
