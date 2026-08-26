import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../optionalCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../optionalCapabilities")>();
  return {
    ...actual,
    SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE: Object.freeze({
      loyalty: false,
      gift_cards: false,
      inventory: true,
    }),
  };
});

import type { LooseDb } from "../looseDb";
import {
  reconcileStaleSquareInventoryCatalogOperations,
  syncSquareInventoryCatalogForSalon,
} from "../inventoryWorker";

const salonId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const attemptToken = "44444444-4444-4444-8444-444444444444";
const materialFingerprint = "a".repeat(64);

const providerMaterial = {
  salon_id: salonId,
  environment: "sandbox",
  api_version: "2026-07-15",
  merchant_id: "merchant-1",
  location_id: "location-1",
  application_id: "sandbox-app-1",
  access_token: "sandbox-token",
};

function database(input?: {
  state?: Record<string, unknown> | null;
  stale?: unknown[];
}) {
  const maybeSingle = vi.fn(async () => ({ data: input?.state ?? null, error: null }));
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle,
  };
  const rpc = vi.fn(async (name: string) => {
    if (name === "resolve_square_feature_operation_material") {
      return {
        data: {
          success: true,
          code: "resolved",
          material_fingerprint: materialFingerprint,
          provider_material: providerMaterial,
        },
        error: null,
      };
    }
    if (name === "claim_square_feature_operation") {
      return {
        data: {
          success: true,
          code: "operation_claimed",
          operation_id: operationId,
          attempt_token: attemptToken,
          provider_material: providerMaterial,
        },
        error: null,
      };
    }
    if (name === "reconcile_stale_square_inventory_catalog_operations") {
      return { data: input?.stale ?? [], error: null };
    }
    if (name === "complete_square_feature_operation") {
      return { data: { success: true, code: "operation_completed" }, error: null };
    }
    if (name === "apply_square_inventory_catalog_page") {
      return {
        data: { success: true, code: "catalog_page_applied", applied: 0, stale_skipped: 0 },
        error: null,
      };
    }
    throw new Error(`unexpected RPC ${name}`);
  });
  return {
    db: { from: vi.fn(() => query), rpc } as unknown as LooseDb,
    rpc,
    maybeSingle,
  };
}

describe("Square Inventory catalog worker orchestration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims, reads, completes and applies an empty incremental page", async () => {
    const { db, rpc } = database();
    const searchCatalog = vi.fn(async () => ({
      latest_time: "2026-08-22T18:00:00Z",
      objects: [],
    }));
    await expect(syncSquareInventoryCatalogForSalon(salonId, {
      db,
      requestId: () => requestId,
      searchCatalog,
    })).resolves.toMatchObject({
      status: "applied",
      operationId,
      applied: 0,
      nextCursor: null,
    });
    expect(searchCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId,
        environment: "sandbox",
        locationId: "location-1",
      }),
      expect.objectContaining({ include_deleted_objects: true }),
      "2026-07-15",
    );
    expect(rpc).toHaveBeenCalledWith(
      "complete_square_feature_operation",
      expect.objectContaining({ p_status: "succeeded" }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "apply_square_inventory_catalog_page",
      expect.objectContaining({
        p_variations: [],
        p_next_cursor: null,
      }),
    );
  });

  it("resumes the persisted provider cursor and retains the next page", async () => {
    const { db, rpc } = database({
      state: {
        last_provider_latest_time: "2026-08-22T18:00:00Z",
        active_catalog_begin_time: "2026-08-22T17:00:00Z",
        active_catalog_cursor: "page-2",
      },
    });
    const searchCatalog = vi.fn(async () => ({
      latest_time: "2026-08-22T18:00:00Z",
      cursor: "page-3",
      objects: [],
    }));
    await expect(syncSquareInventoryCatalogForSalon(salonId, {
      db,
      requestId: () => requestId,
      searchCatalog,
    }, 1)).resolves.toMatchObject({
      status: "applied",
      nextCursor: "page-3",
    });
    expect(searchCatalog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        begin_time: "2026-08-22T17:00:00Z",
        cursor: "page-2",
      }),
      "2026-07-15",
    );
    expect(rpc).toHaveBeenCalledWith(
      "apply_square_inventory_catalog_page",
      expect.objectContaining({
        p_scan_begin_time: "2026-08-22T17:00:00Z",
        p_next_cursor: "page-3",
      }),
    );
  });

  it("leaves a read lease recoverable when provider transport is ambiguous", async () => {
    const { db, rpc } = database();
    const searchCatalog = vi.fn(async () => {
      throw new Error("response lost");
    });
    await expect(syncSquareInventoryCatalogForSalon(salonId, {
      db,
      requestId: () => requestId,
      searchCatalog,
    })).resolves.toEqual({
      status: "retry_pending",
      reason: "provider_read_unavailable",
      operationId,
    });
    expect(rpc).not.toHaveBeenCalledWith(
      "complete_square_feature_operation",
      expect.anything(),
    );
    expect(rpc).not.toHaveBeenCalledWith(
      "apply_square_inventory_catalog_page",
      expect.anything(),
    );
  });

  it("reclaims only a catalog read and resolves fresh provider material", async () => {
    const { db, rpc } = database({
      stale: [{
        success: true,
        code: "reconciliation_claimed",
        salon_id: salonId,
        operation_id: operationId,
        attempt_token: attemptToken,
        material_fingerprint: materialFingerprint,
        material: { source_id: "2026-08-22T17:00:00Z", secondary_id: "page-2" },
      }],
    });
    const searchCatalog = vi.fn(async () => ({
      latest_time: "2026-08-22T18:00:00Z",
      objects: [],
    }));
    await expect(reconcileStaleSquareInventoryCatalogOperations({
      db,
      searchCatalog,
    })).resolves.toEqual([
      expect.objectContaining({ status: "applied", operationId }),
    ]);
    expect(rpc).toHaveBeenCalledWith(
      "resolve_square_feature_operation_material",
      expect.objectContaining({
        p_operation_kind: "inventory_catalog_variation_load",
      }),
    );
    expect(searchCatalog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cursor: "page-2" }),
      "2026-07-15",
    );
  });
});
