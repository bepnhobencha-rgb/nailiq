import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  searchSquareInventoryCatalogObjects,
  type SquareConfig,
} from "./client";
import {
  buildSquareInventoryCatalogSearchRequest,
  sanitizeSquareInventoryCatalogPage,
} from "./inventoryReconciliation";
import { looseServiceClient, type LooseDb } from "./looseDb";
import {
  SQUARE_OPTIONAL_API_VERSION,
  SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE,
} from "./optionalCapabilities";

type JsonRecord = Record<string, unknown>;

type WorkerDependencies = {
  db?: LooseDb;
  requestId?: () => string;
  searchCatalog?: typeof searchSquareInventoryCatalogObjects;
};

export type SquareInventoryWorkerResult =
  | { status: "disabled"; reason: "app_contract_unavailable" }
  | { status: "not_ready"; reason: string }
  | { status: "retry_pending"; reason: string; operationId?: string }
  | { status: "failed"; reason: string; operationId?: string }
  | {
      status: "applied";
      operationId: string;
      applied: number;
      staleSkipped: number;
      latestTime: string;
      nextCursor: string | null;
    };

type CatalogRequestMaterial = {
  source_id: string;
  secondary_id: string;
};

type ClaimedCatalogOperation = {
  salonId: string;
  operationId: string;
  attemptToken: string;
  materialFingerprint: string;
  request: CatalogRequestMaterial;
  providerMaterial?: unknown;
};

const FULL_SCAN = "__full_catalog__";
const FIRST_PAGE = "__first_page__";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, max = 255): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestMaterial(
  beginTime: string | null,
  cursor: string | null,
): CatalogRequestMaterial {
  return {
    source_id: beginTime ?? FULL_SCAN,
    secondary_id: cursor ?? FIRST_PAGE,
  };
}

function parseRequestMaterial(value: unknown): {
  material: CatalogRequestMaterial;
  beginTime: string | null;
  cursor: string | null;
} | null {
  const row = record(value);
  const sourceId = text(row?.source_id);
  const secondaryId = text(row?.secondary_id, 2048);
  if (!sourceId || !secondaryId) return null;
  const beginTime = sourceId === FULL_SCAN ? null : sourceId;
  const cursor = secondaryId === FIRST_PAGE ? null : secondaryId;
  if (!buildSquareInventoryCatalogSearchRequest({ latestTime: beginTime, cursor })) {
    return null;
  }
  return {
    material: { source_id: sourceId, secondary_id: secondaryId },
    beginTime,
    cursor,
  };
}

function providerConfig(value: unknown, salonId: string): SquareConfig | null {
  const row = record(value);
  const environment = row?.environment;
  const providerSalonId = text(row?.salon_id);
  const merchantId = text(row?.merchant_id);
  const locationId = text(row?.location_id);
  const accessToken = text(row?.access_token, 4096);
  const applicationId = text(row?.application_id);
  if (
    providerSalonId !== salonId ||
    (environment !== "sandbox" && environment !== "production") ||
    row?.api_version !== SQUARE_OPTIONAL_API_VERSION ||
    !merchantId || !locationId || !accessToken || !applicationId
  ) return null;
  return {
    salonId,
    merchantId,
    locationId,
    accessToken,
    applicationId,
    environment,
    currency: "USD",
    sync: {
      pullCreate: false,
      pullUpdate: false,
      pullCancel: false,
      pushCreate: false,
      pushUpdate: false,
      pushCancel: false,
    },
  };
}

async function resolveProviderMaterial(
  db: LooseDb,
  operation: ClaimedCatalogOperation,
): Promise<{ config: SquareConfig; beginTime: string | null; cursor: string | null } | SquareInventoryWorkerResult> {
  const parsed = parseRequestMaterial(operation.request);
  if (!parsed) return { status: "failed", reason: "invalid_operation_material", operationId: operation.operationId };
  let providerMaterial = operation.providerMaterial;
  if (!providerMaterial) {
    const resolved = await db.rpc("resolve_square_feature_operation_material", {
      p_salon_id: operation.salonId,
      p_operation_kind: "inventory_catalog_variation_load",
      p_request: operation.request,
    });
    if (resolved.error) {
      return { status: "retry_pending", reason: "material_resolution_unavailable", operationId: operation.operationId };
    }
    const row = record(resolved.data);
    if (row?.code !== "resolved") {
      return { status: "not_ready", reason: String(row?.code ?? "integration_not_ready") };
    }
    if (row.material_fingerprint !== operation.materialFingerprint) {
      return { status: "failed", reason: "material_fingerprint_changed", operationId: operation.operationId };
    }
    providerMaterial = row.provider_material;
  }
  const config = providerConfig(providerMaterial, operation.salonId);
  if (!config) return { status: "failed", reason: "invalid_provider_material", operationId: operation.operationId };
  return { config, beginTime: parsed.beginTime, cursor: parsed.cursor };
}

async function completeOperation(
  db: LooseDb,
  operation: ClaimedCatalogOperation,
  input: {
    status: "succeeded" | "failed";
    providerObjectId: string | null;
    providerReceiptId: string | null;
    resultFingerprint: string;
    errorCode: string | null;
  },
): Promise<boolean> {
  const completed = await db.rpc("complete_square_feature_operation", {
    p_operation_id: operation.operationId,
    p_attempt_token: operation.attemptToken,
    p_status: input.status,
    p_provider_object_id: input.providerObjectId,
    p_provider_receipt_id: input.providerReceiptId,
    p_result_fingerprint: input.resultFingerprint,
    p_error_code: input.errorCode,
  });
  return !completed.error && record(completed.data)?.success === true;
}

async function processClaimedCatalogOperation(
  operation: ClaimedCatalogOperation,
  deps: Required<Pick<WorkerDependencies, "db" | "searchCatalog">>,
): Promise<SquareInventoryWorkerResult> {
  const resolved = await resolveProviderMaterial(deps.db, operation);
  if (!("config" in resolved)) return resolved;
  const request = buildSquareInventoryCatalogSearchRequest({
    latestTime: resolved.beginTime,
    cursor: resolved.cursor,
  });
  if (!request) {
    const resultFingerprint = sha256({ code: "invalid_catalog_request" });
    await completeOperation(deps.db, operation, {
      status: "failed",
      providerObjectId: null,
      providerReceiptId: null,
      resultFingerprint,
      errorCode: "invalid_catalog_request",
    });
    return { status: "failed", reason: "invalid_catalog_request", operationId: operation.operationId };
  }

  let rawPage: Record<string, unknown>;
  try {
    rawPage = await deps.searchCatalog(
      resolved.config,
      request,
      SQUARE_OPTIONAL_API_VERSION,
    );
  } catch {
    // SearchCatalogObjects is read-only. Keep the durable lease unresolved so
    // the catalog-only stale reconciler can safely repeat the exact read.
    return { status: "retry_pending", reason: "provider_read_unavailable", operationId: operation.operationId };
  }
  const page = sanitizeSquareInventoryCatalogPage(rawPage, resolved.config.locationId);
  if (!page) {
    const resultFingerprint = sha256({ code: "invalid_catalog_response" });
    await completeOperation(deps.db, operation, {
      status: "failed",
      providerObjectId: null,
      providerReceiptId: null,
      resultFingerprint,
      errorCode: "invalid_catalog_response",
    });
    return { status: "failed", reason: "invalid_catalog_response", operationId: operation.operationId };
  }

  const payloadFingerprint = sha256(page);
  const receiptId = `catalog:${page.latestTime}:${payloadFingerprint.slice(0, 24)}`;
  const completed = await completeOperation(deps.db, operation, {
    status: "succeeded",
    providerObjectId: `catalog-search:${page.latestTime}`,
    providerReceiptId: receiptId,
    resultFingerprint: payloadFingerprint,
    errorCode: null,
  });
  if (!completed) {
    return { status: "retry_pending", reason: "operation_completion_unavailable", operationId: operation.operationId };
  }

  const applied = await deps.db.rpc("apply_square_inventory_catalog_page", {
    p_salon_id: operation.salonId,
    p_operation_id: operation.operationId,
    p_provider_latest_time: page.latestTime,
    p_next_cursor: page.cursor,
    p_scan_begin_time: resolved.beginTime,
    p_variations: page.variations,
    p_payload_fingerprint: payloadFingerprint,
  });
  const appliedRow = record(applied.data);
  if (applied.error || appliedRow?.success !== true) {
    return { status: "retry_pending", reason: String(appliedRow?.code ?? "catalog_apply_unavailable"), operationId: operation.operationId };
  }
  return {
    status: "applied",
    operationId: operation.operationId,
    applied: Number(appliedRow.applied ?? 0),
    staleSkipped: Number(appliedRow.stale_skipped ?? 0),
    latestTime: page.latestTime,
    nextCursor: page.cursor,
  };
}

async function claimFreshCatalogOperation(
  salonId: string,
  beginTime: string | null,
  cursor: string | null,
  deps: Required<Pick<WorkerDependencies, "db" | "requestId">>,
): Promise<ClaimedCatalogOperation | SquareInventoryWorkerResult> {
  const request = requestMaterial(beginTime, cursor);
  const resolved = await deps.db.rpc("resolve_square_feature_operation_material", {
    p_salon_id: salonId,
    p_operation_kind: "inventory_catalog_variation_load",
    p_request: request,
  });
  if (resolved.error) return { status: "retry_pending", reason: "material_resolution_unavailable" };
  const resolvedRow = record(resolved.data);
  if (resolvedRow?.code !== "resolved" || typeof resolvedRow.material_fingerprint !== "string") {
    return { status: "not_ready", reason: String(resolvedRow?.code ?? "integration_not_ready") };
  }
  const requestId = deps.requestId();
  if (!UUID_RE.test(requestId)) return { status: "failed", reason: "invalid_request_id" };
  const claimed = await deps.db.rpc("claim_square_feature_operation", {
    p_salon_id: salonId,
    p_request_id: requestId,
    p_operation_kind: "inventory_catalog_variation_load",
    p_request: request,
    p_expected_material_fingerprint: resolvedRow.material_fingerprint,
  });
  if (claimed.error) return { status: "retry_pending", reason: "operation_claim_unavailable" };
  const row = record(claimed.data);
  if (
    row?.success !== true || row.code !== "operation_claimed" ||
    typeof row.operation_id !== "string" || typeof row.attempt_token !== "string"
  ) return { status: "failed", reason: String(row?.code ?? "operation_claim_rejected") };
  return {
    salonId,
    operationId: row.operation_id,
    attemptToken: row.attempt_token,
    materialFingerprint: resolvedRow.material_fingerprint,
    request,
    providerMaterial: row.provider_material,
  };
}

function dependencies(input: WorkerDependencies): Required<WorkerDependencies> {
  return {
    db: input.db ?? looseServiceClient(),
    requestId: input.requestId ?? randomUUID,
    searchCatalog: input.searchCatalog ?? searchSquareInventoryCatalogObjects,
  };
}

/**
 * Start or resume a bounded provider catalog scan for one salon. This is wired
 * to cron while the application contract remains hard-off, so current runtime
 * execution returns before any DB or provider call.
 */
export async function syncSquareInventoryCatalogForSalon(
  salonId: string,
  input: WorkerDependencies = {},
  maxPages = 20,
): Promise<SquareInventoryWorkerResult> {
  if (!SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE.inventory) {
    return { status: "disabled", reason: "app_contract_unavailable" };
  }
  if (!UUID_RE.test(salonId) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    return { status: "failed", reason: "invalid_worker_input" };
  }
  const deps = dependencies(input);
  const stateResult = await deps.db
    .from("square_inventory_catalog_sync_state")
    .select("last_provider_latest_time, active_catalog_begin_time, active_catalog_cursor")
    .eq("salon_id", salonId)
    .maybeSingle();
  if (stateResult.error) return { status: "retry_pending", reason: "sync_state_unavailable" };
  const state = stateResult.data;
  let cursor = typeof state?.active_catalog_cursor === "string"
    ? state.active_catalog_cursor : null;
  const activeBegin = typeof state?.active_catalog_begin_time === "string"
    ? state.active_catalog_begin_time : null;
  const lastLatest = typeof state?.last_provider_latest_time === "string"
    ? state.last_provider_latest_time : null;
  const beginTime = cursor ? activeBegin : lastLatest;
  let last: SquareInventoryWorkerResult = { status: "failed", reason: "no_catalog_page" };
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const operation = await claimFreshCatalogOperation(salonId, beginTime, cursor, deps);
    if (!("operationId" in operation) || !("attemptToken" in operation)) return operation;
    last = await processClaimedCatalogOperation(operation, deps);
    if (last.status !== "applied" || last.nextCursor === null) return last;
    cursor = last.nextCursor;
  }
  return last.status === "applied"
    ? { ...last, status: "applied", nextCursor: cursor }
    : last;
}

/** Safely reclaim only stale read-only catalog operations, never adjustments. */
export async function reconcileStaleSquareInventoryCatalogOperations(
  input: WorkerDependencies = {},
  limit = 25,
): Promise<SquareInventoryWorkerResult[]> {
  if (!SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE.inventory) {
    return [{ status: "disabled", reason: "app_contract_unavailable" }];
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return [{ status: "failed", reason: "invalid_worker_input" }];
  }
  const deps = dependencies(input);
  const claimed = await deps.db.rpc(
    "reconcile_stale_square_inventory_catalog_operations",
    { p_limit: limit },
  );
  if (claimed.error) return [{ status: "retry_pending", reason: "stale_claim_unavailable" }];
  if (!Array.isArray(claimed.data)) return [];
  const results: SquareInventoryWorkerResult[] = [];
  for (const value of claimed.data) {
    const row = record(value);
    const parsed = parseRequestMaterial(row?.material);
    if (
      row?.success !== true || row.code !== "reconciliation_claimed" ||
      typeof row.salon_id !== "string" || typeof row.operation_id !== "string" ||
      typeof row.attempt_token !== "string" ||
      typeof row.material_fingerprint !== "string" || !parsed
    ) {
      results.push({ status: "failed", reason: "invalid_stale_claim" });
      continue;
    }
    results.push(await processClaimedCatalogOperation({
      salonId: row.salon_id,
      operationId: row.operation_id,
      attemptToken: row.attempt_token,
      materialFingerprint: row.material_fingerprint,
      request: parsed.material,
    }, deps));
  }
  return results;
}
