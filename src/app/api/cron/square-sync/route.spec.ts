import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SALON_ID = "62000000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  integrationLoadError: null as Record<string, unknown> | null,
  healthWriteError: null as Record<string, unknown> | null,
  healthWrites: [] as Array<Record<string, unknown>>,
  v1AllowsCustomerPaymentGateway: true,
  runSquareForwardSync: vi.fn(),
  reconcileDeposits: vi.fn(),
  reconcileNoShowFeeLinks: vi.fn(),
  syncSquareVisitHistory: vi.fn(),
  reconcileStaleSquareInventoryCatalogOperations: vi.fn(),
  syncSquareInventoryCatalogForSalon: vi.fn(),
  processSquareOptionalWebhookInbox: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/cronAuthorization", () => ({
  requireCronAuthorization: () => null,
}));
vi.mock("@/shared/security/cronRunHistory", () => ({
  runTrackedCron: (_worker: string, handler: () => Promise<Response>) => handler(),
}));
vi.mock("@/shared/release/v1IntegrationScope", () => ({
  v1AllowsCustomerPaymentGateway: () => mocks.v1AllowsCustomerPaymentGateway,
}));
vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({
    from: () => {
      let updateValues: Record<string, unknown> | null = null;
      const chain = {
        select: () => chain,
        update: (values: Record<string, unknown>) => {
          updateValues = values;
          return chain;
        },
        eq: () => chain,
        not: () => chain,
        then: <TResult1 = unknown, TResult2 = never>(
          onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) => {
          const result = updateValues
            ? { data: null, error: mocks.healthWriteError }
            : {
                data: mocks.integrationLoadError ? null : [{ salon_id: SALON_ID }],
                error: mocks.integrationLoadError,
              };
          if (updateValues) mocks.healthWrites.push(structuredClone(updateValues));
          return Promise.resolve(result).then(onfulfilled, onrejected);
        },
      };
      return chain;
    },
  }),
}));
vi.mock("@/shared/integrations/square/sync", () => ({
  runSquareForwardSync: mocks.runSquareForwardSync,
}));
vi.mock("@/shared/integrations/square/deposits", () => ({
  reconcileDeposits: mocks.reconcileDeposits,
}));
vi.mock("@/shared/integrations/square/noshow", () => ({
  reconcileNoShowFeeLinks: mocks.reconcileNoShowFeeLinks,
}));
vi.mock("@/shared/integrations/square/visitSync", () => ({
  syncSquareVisitHistory: mocks.syncSquareVisitHistory,
}));
vi.mock("@/shared/integrations/square/inventoryWorker", () => ({
  reconcileStaleSquareInventoryCatalogOperations:
    mocks.reconcileStaleSquareInventoryCatalogOperations,
  syncSquareInventoryCatalogForSalon: mocks.syncSquareInventoryCatalogForSalon,
}));
vi.mock("@/shared/integrations/square/optionalWebhookWorker", () => ({
  processSquareOptionalWebhookInbox: mocks.processSquareOptionalWebhookInbox,
}));

import { GET } from "./route";

function request() {
  return new NextRequest("https://nailiq.test/api/cron/square-sync");
}

describe("GET /api/cron/square-sync health truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.integrationLoadError = null;
    mocks.healthWriteError = null;
    mocks.healthWrites.length = 0;
    mocks.v1AllowsCustomerPaymentGateway = true;
    mocks.runSquareForwardSync.mockResolvedValue({ pulled: 0 });
    mocks.reconcileDeposits.mockResolvedValue({ ok: true, checked: 0, paid: 0 });
    mocks.reconcileNoShowFeeLinks.mockResolvedValue({ ok: true, checked: 0, paid: 0 });
    mocks.syncSquareVisitHistory.mockResolvedValue({
      ok: true,
      paymentsScanned: 0,
      upserted: 0,
      withServices: 0,
    });
    mocks.reconcileStaleSquareInventoryCatalogOperations.mockResolvedValue([
      { status: "disabled", reason: "app_contract_unavailable" },
    ]);
    mocks.syncSquareInventoryCatalogForSalon.mockResolvedValue({
      status: "disabled",
      reason: "app_contract_unavailable",
    });
    mocks.processSquareOptionalWebhookInbox.mockResolvedValue([
      { status: "disabled", capability: "inventory" },
    ]);
  });

  it("skips only Phase 2 payment reconciliation while operational sync stays healthy", async () => {
    mocks.v1AllowsCustomerPaymentGateway = false;

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      results: {
        [SALON_ID]: {
          deposits: {
            ok: true,
            checked: 0,
            paid: 0,
            skipped: "phase_2_not_available",
          },
          noShowFees: {
            ok: true,
            checked: 0,
            paid: 0,
            skipped: "phase_2_not_available",
          },
        },
      },
    });
    expect(mocks.runSquareForwardSync).toHaveBeenCalledWith(SALON_ID);
    expect(mocks.reconcileDeposits).not.toHaveBeenCalled();
    expect(mocks.reconcileNoShowFeeLinks).not.toHaveBeenCalled();
    expect(mocks.syncSquareVisitHistory).toHaveBeenCalledWith(SALON_ID);
    expect(mocks.reconcileStaleSquareInventoryCatalogOperations).toHaveBeenCalledOnce();
    expect(mocks.syncSquareInventoryCatalogForSalon).toHaveBeenCalledWith(SALON_ID);
    expect(mocks.processSquareOptionalWebhookInbox).toHaveBeenCalledTimes(3);
  });

  it("returns success only when every salon sync succeeds", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(mocks.healthWrites).toHaveLength(0);
  });

  it("returns HTTP 500 when any salon sync fails, after persisting last_error", async () => {
    mocks.runSquareForwardSync.mockRejectedValue(
      new Error("square_sync_service_inventory_unavailable"),
    );

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      results: {
        [SALON_ID]: { error: "square_sync_service_inventory_unavailable" },
      },
    });
    expect(mocks.healthWrites).toEqual([
      expect.objectContaining({
        last_error: "square_sync_service_inventory_unavailable",
      }),
    ]);
  });

  it("returns HTTP 500 and an honest stable error when last_error persistence fails", async () => {
    mocks.runSquareForwardSync.mockRejectedValue(
      new Error("square_sync_staff_inventory_unavailable"),
    );
    mocks.healthWriteError = { code: "42501", message: "private database detail" };

    const response = await GET(request());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      results: {
        [SALON_ID]: { error: "square_sync_health_write_failed" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("private database detail");
  });

  it("persists a stable salon failure when visit sync reports ok=false", async () => {
    mocks.syncSquareVisitHistory.mockResolvedValue({
      ok: false,
      paymentsScanned: 12,
      upserted: 0,
      withServices: 0,
      error: "private provider detail",
    });

    const response = await GET(request());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      results: { [SALON_ID]: { error: "square_visit_sync_unhealthy" } },
    });
    expect(mocks.healthWrites).toEqual([
      expect.objectContaining({ last_error: "square_visit_sync_unhealthy" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("private provider detail");
  });

  it("returns HTTP 500 and persists a stable deposit reconciliation failure", async () => {
    mocks.reconcileDeposits.mockResolvedValue({
      ok: false,
      checked: 4,
      paid: 1,
      error: "square_deposit_reconciliation_claim_unavailable",
    });

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      results: {
        [SALON_ID]: { error: "square_deposit_reconciliation_claim_unavailable" },
      },
    });
    expect(mocks.healthWrites).toEqual([
      expect.objectContaining({
        last_error: "square_deposit_reconciliation_claim_unavailable",
      }),
    ]);
    expect(mocks.reconcileNoShowFeeLinks).not.toHaveBeenCalled();
    expect(mocks.syncSquareVisitHistory).not.toHaveBeenCalled();
  });

  it("returns HTTP 500 and persists a stable no-show reconciliation failure", async () => {
    mocks.reconcileNoShowFeeLinks.mockResolvedValue({
      ok: false,
      checked: 2,
      paid: 0,
      error: "square_noshow_reconciliation_write_unavailable",
    });

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      results: {
        [SALON_ID]: { error: "square_noshow_reconciliation_write_unavailable" },
      },
    });
    expect(mocks.healthWrites).toEqual([
      expect.objectContaining({
        last_error: "square_noshow_reconciliation_write_unavailable",
      }),
    ]);
    expect(mocks.syncSquareVisitHistory).not.toHaveBeenCalled();
  });

  it.each(["failed", "retry_pending"])(
    "persists a stable salon failure for per-salon inventory status %s",
    async (status) => {
      mocks.syncSquareInventoryCatalogForSalon.mockResolvedValue({
        status,
        reason: "private inventory detail",
      });

      const response = await GET(request());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({
        ok: false,
        results: { [SALON_ID]: { error: "square_inventory_sync_unhealthy" } },
      });
      expect(mocks.healthWrites).toEqual([
        expect.objectContaining({ last_error: "square_inventory_sync_unhealthy" }),
      ]);
      expect(JSON.stringify(body)).not.toContain("private inventory detail");
    },
  );

  it.each(["failed", "retry_pending"])(
    "returns a redacted HTTP 500 for global inventory recovery status %s",
    async (status) => {
      mocks.reconcileStaleSquareInventoryCatalogOperations.mockResolvedValue([
        { status, reason: "private recovery detail" },
      ]);

      const response = await GET(request());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({
        ok: false,
        error: "square_sync_global_worker_unhealthy",
        inventoryRecovery: [{ status }],
      });
      expect(JSON.stringify(body)).not.toContain("private recovery detail");
    },
  );

  it("returns a redacted HTTP 500 when any optional webhook worker needs retry", async () => {
    mocks.processSquareOptionalWebhookInbox
      .mockResolvedValueOnce([{
        status: "retry_pending",
        capability: "loyalty",
        reason: "private optional detail",
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const response = await GET(request());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      error: "square_sync_global_worker_unhealthy",
      optionalWebhookWorkers: {
        loyalty: [{ status: "retry_pending" }],
        giftCards: [],
        inventory: [],
      },
    });
    expect(JSON.stringify(body)).not.toContain("private optional detail");
  });

  it("keeps disabled, applied, not-ready and empty worker results healthy", async () => {
    mocks.reconcileStaleSquareInventoryCatalogOperations.mockResolvedValue([
      { status: "applied", reason: "done" },
      { status: "not_ready", reason: "integration_not_ready" },
    ]);
    mocks.syncSquareInventoryCatalogForSalon.mockResolvedValue({
      status: "not_ready",
      reason: "integration_not_ready",
    });
    mocks.processSquareOptionalWebhookInbox
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: "applied", capability: "gift_cards" }])
      .mockResolvedValueOnce([{ status: "disabled", capability: "inventory" }]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(mocks.healthWrites).toHaveLength(0);
  });

  it("returns a stable failure if a global worker throws", async () => {
    mocks.reconcileStaleSquareInventoryCatalogOperations.mockRejectedValue(
      new Error("private database detail"),
    );

    const response = await GET(request());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ ok: false, error: "square_sync_global_worker_unavailable" });
    expect(JSON.stringify(body)).not.toContain("private database detail");
    expect(mocks.runSquareForwardSync).not.toHaveBeenCalled();
  });

  it("does not expose raw integration inventory errors", async () => {
    mocks.integrationLoadError = { code: "42501", message: "private database detail" };

    const response = await GET(request());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      error: "square_sync_integration_inventory_unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("private database detail");
  });

  it("redacts an unexpected per-salon exception before persisting health", async () => {
    mocks.runSquareForwardSync.mockRejectedValue(
      new Error("private row detail for customer@example.test"),
    );

    const response = await GET(request());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      results: { [SALON_ID]: { error: "square_sync_salon_failed" } },
    });
    expect(mocks.healthWrites).toEqual([
      expect.objectContaining({ last_error: "square_sync_salon_failed" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("customer@example.test");
  });
});
