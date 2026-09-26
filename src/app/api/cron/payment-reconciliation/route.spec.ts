import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  runTrackedCron: vi.fn(),
  reconcileContinuations: vi.fn(),
  parseMaterial: vi.fn(),
  parseClaim: vi.fn(),
  dispatch: vi.fn(),
  feePreflight: vi.fn(),
  claimReady: vi.fn(),
  readyProvider: vi.fn(),
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
  parseBookingPaymentOperationMaterial: mocks.parseMaterial,
  parseClaimedBookingPaymentOperation: mocks.parseClaim,
  parsePublicDepositPaymentMaterial: () => null,
}));
vi.mock("@/shared/payments/preflightFeePaymentReconciliation", () => ({
  preflightFeePaymentReconciliation: mocks.feePreflight,
  claimReadyFeePaymentReconciliations: mocks.claimReady,
  preflightProviderForClaim: mocks.readyProvider,
}));
vi.mock("@/shared/payments/executeBookingPaymentOperation", () => ({
  dispatchClaimedBookingPaymentOperation: mocks.dispatch,
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
vi.mock("@/shared/booking/reconcileBookingCardSaveOperations", () => ({
  reconcileBookingCardSaveOperations: vi.fn(async () => ({
    ok: true, processed: 0, reconciled: 0, unresolved: 0,
  })),
}));
vi.mock("@/shared/booking/reconcileBookingCardContinuations", () => ({
  reconcileBookingCardContinuations: mocks.reconcileContinuations,
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
    vi.stubEnv("BOOKING_CARD_CONTINUATION_RECONCILIATION_ENABLED", "false");
    vi.stubEnv("BOOKING_CARD_RECONCILIATION_ENABLED", "false");
    vi.stubEnv("NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH", "false");
    vi.stubEnv("NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH", "false");
    mocks.parseMaterial.mockReturnValue(null);
    mocks.parseClaim.mockReturnValue(null);
    mocks.dispatch.mockResolvedValue({ ok: true });
    mocks.feePreflight.mockResolvedValue({ claims: [], ready: new Map(), unresolved: 0, scanLimitReached: false });
    mocks.readyProvider.mockReturnValue(null);
    mocks.reconcileContinuations.mockResolvedValue({
      ok: true, processed: 0, awaitingCustomer: 0, pendingProvider: 0,
      resolved: 0, manualReview: 0, errors: 0,
    });
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
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "discover_due_enabled_booking_payment_reconciliations",
      { p_operation_kinds: ["deposit_charge", "deposit_refund"], p_limit: 25 },
    );
  });

  it("runs the no-provider continuation worker while payment workers are off", async () => {
    vi.stubEnv("PAYMENT_LEDGER_WORKERS_ENABLED", "false");
    vi.stubEnv("BOOKING_CARD_CONTINUATION_RECONCILIATION_ENABLED", "true");
    mocks.reconcileContinuations.mockResolvedValueOnce({
      ok: true, processed: 2, awaitingCustomer: 1, pendingProvider: 1,
      resolved: 0, manualReview: 0, errors: 0,
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      processed: 2,
      unresolved: 0,
      continuation: {
        awaitingCustomer: 1,
        pendingProvider: 1,
      },
    });
    expect(mocks.reconcileContinuations).toHaveBeenCalledWith(10);
    expect(mocks.rpc).not.toHaveBeenCalled();
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

  it.each([
    ["late_cancel_charge", "NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH", "approved_cancellation_fee"],
    ["noshow_charge", "NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH", "approved_no_show_charge"],
  ])("reconciles released %s with its tenant-allowlisted provider purpose", async (
    operationKind, flag, providerPurpose,
  ) => {
    vi.stubEnv(flag, "true");
    const material = { operationKind };
    const claim = { operationId: "approved-operation", material };
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const provider = { kind: "square" };
    mocks.feePreflight.mockResolvedValue({ claims: [{ operation_kind: operationKind }], ready: new Map(), unresolved: 0, scanLimitReached: false });
    mocks.readyProvider.mockReturnValue(provider);
    mocks.parseMaterial.mockReturnValue(material);
    mocks.parseClaim.mockReturnValue(claim);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "discover_due_enabled_booking_payment_reconciliations",
      { p_operation_kinds: ["deposit_charge", "deposit_refund"], p_limit: 25 },
    );
    expect(mocks.feePreflight).toHaveBeenCalledWith(expect.anything(), [{ kind: operationKind, purpose: providerPurpose }]);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({
      db: expect.anything(), claim, providerPurpose, provider,
    });
    expect(await response.json()).toMatchObject({ succeeded: 1, unresolved: 0 });
  });

  it.each([
    ["late_cancel_charge", "NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH"],
    ["noshow_charge", "NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH"],
    ["late_cancel_refund", "NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH"],
    ["noshow_refund", "NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH"],
  ])("keeps %s blocked when only %s is enabled", async (operationKind, flag) => {
    vi.stubEnv(flag, "true");
    mocks.rpc.mockResolvedValue({ data: [{ operation_kind: operationKind }], error: null });
    mocks.parseMaterial.mockReturnValue({ operationKind });
    mocks.parseClaim.mockReturnValue({ material: { operationKind } });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ succeeded: 0, unresolved: 1 });
  });

  it("does not dispatch a released cancellation whose durable claim is invalid", async () => {
    vi.stubEnv("NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH", "true");
    mocks.rpc.mockResolvedValue({ data: [{ operation_kind: "late_cancel_charge" }], error: null });
    mocks.parseMaterial.mockReturnValue({ operationKind: "late_cancel_charge" });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("finishes all configuration reads before any SQL lease and reports config outages", async () => {
    vi.stubEnv("NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH", "true");
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.feePreflight.mockResolvedValue({ claims: [], ready: new Map(), unresolved: 2, scanLimitReached: false });
    const response = await GET(request());
    expect(mocks.feePreflight.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.claimReady.mock.invocationCallOrder[0]);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ processed: 0, unresolved: 2,
      feePreflight: { unresolved: 2, scanLimitReached: false } });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("never falls back to resolving a provider after an unexpected fee claim", async () => {
    vi.stubEnv("NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH", "true");
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.feePreflight.mockResolvedValue({ claims: [{ operation_kind: "noshow_charge" }], ready: new Map(), unresolved: 0, scanLimitReached: false });
    mocks.parseMaterial.mockReturnValue({ operationKind: "noshow_charge" });
    mocks.parseClaim.mockReturnValue({ operationId: "unexpected", material: { operationKind: "noshow_charge" } });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(mocks.readyProvider).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
