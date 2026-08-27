/**
 * Forward-syncs Square bookings into NailIQ for every enabled `square_integrations`
 * row. Called by Vercel Cron (see vercel.json). Secured by CRON_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { looseServiceClient } from "@/shared/integrations/square/looseDb";
import { runSquareForwardSync } from "@/shared/integrations/square/sync";
import { reconcileDeposits } from "@/shared/integrations/square/deposits";
import { reconcileNoShowFeeLinks } from "@/shared/integrations/square/noshow";
import { syncSquareVisitHistory } from "@/shared/integrations/square/visitSync";
import {
  reconcileStaleSquareInventoryCatalogOperations,
  syncSquareInventoryCatalogForSalon,
} from "@/shared/integrations/square/inventoryWorker";
import { processSquareOptionalWebhookInbox } from "@/shared/integrations/square/optionalWebhookWorker";
import { v1AllowsSquareOperationalSync } from "@/shared/release/v1IntegrationScope";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const maxDuration = 60;

const SAFE_FAILURE_CODE = /^[a-z0-9_:-]{1,160}$/u;
const HEALTHY_INVENTORY_STATUSES = new Set(["disabled", "applied", "not_ready"]);
const HEALTHY_OPTIONAL_STATUSES = new Set(["disabled", "applied"]);

function stableSalonFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_FAILURE_CODE.test(message) ? message : "square_sync_salon_failed";
}

function workerStatus(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function unhealthyWorkerResult(value: unknown, healthy: ReadonlySet<string>): boolean {
  const status = workerStatus(value);
  return status === null || !healthy.has(status);
}

function unhealthyWorkerResults(value: unknown, healthy: ReadonlySet<string>): boolean {
  return !Array.isArray(value) || value.some((result) => unhealthyWorkerResult(result, healthy));
}

function redactWorkerResults(value: unknown): Array<{ status: string }> {
  if (!Array.isArray(value)) return [{ status: "unknown" }];
  return value.map((result) => ({ status: workerStatus(result) ?? "unknown" }));
}

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("square_sync", async () => {
  if (!v1AllowsSquareOperationalSync()) {
    return NextResponse.json({ ok: true, skipped: "phase_2_not_available" });
  }

  const supabase = looseServiceClient();
  const { data: integrations, error } = await supabase
    .from("square_integrations")
    .select("salon_id")
    .eq("enabled", true)
    .not("access_token", "is", null);

  if (error) {
    console.error("[square-sync] load integrations");
    return NextResponse.json(
      { ok: false, error: "square_sync_integration_inventory_unavailable" },
      { status: 500 },
    );
  }

  const results: Record<string, unknown> = {};
  // Inventory is wired but its application contract is hard-off. Until a
  // separately approved sandbox acceptance changes that code gate, both calls
  // return before DB/provider dispatch.
  let inventoryRecovery: Awaited<ReturnType<typeof reconcileStaleSquareInventoryCatalogOperations>>;
  let optionalWebhookWorkers: {
    loyalty: Awaited<ReturnType<typeof processSquareOptionalWebhookInbox>>;
    giftCards: Awaited<ReturnType<typeof processSquareOptionalWebhookInbox>>;
    inventory: Awaited<ReturnType<typeof processSquareOptionalWebhookInbox>>;
  };
  try {
    inventoryRecovery = await reconcileStaleSquareInventoryCatalogOperations();
    optionalWebhookWorkers = {
      loyalty: await processSquareOptionalWebhookInbox("loyalty"),
      giftCards: await processSquareOptionalWebhookInbox("gift_cards"),
      inventory: await processSquareOptionalWebhookInbox("inventory"),
    };
  } catch {
    return NextResponse.json(
      { ok: false, error: "square_sync_global_worker_unavailable" },
      { status: 500 },
    );
  }
  const globalWorkerUnhealthy =
    unhealthyWorkerResults(inventoryRecovery, HEALTHY_INVENTORY_STATUSES) ||
    Object.values(optionalWebhookWorkers).some((workerResults) =>
      unhealthyWorkerResults(workerResults, HEALTHY_OPTIONAL_STATUSES));
  let failedSalons = 0;
  for (const it of integrations ?? []) {
    const salonId = it.salon_id as string;
    try {
      const sync = await runSquareForwardSync(salonId);
      const deposits = await reconcileDeposits(salonId);
      if (!deposits.ok) {
        throw new Error(deposits.error ?? "square_deposit_reconciliation_unhealthy");
      }
      const noShowFees = await reconcileNoShowFeeLinks(salonId);
      if (!noShowFees.ok) {
        throw new Error(noShowFees.error ?? "square_noshow_reconciliation_unhealthy");
      }
      const visits = await syncSquareVisitHistory(salonId);
      if (visits.ok !== true) throw new Error("square_visit_sync_unhealthy");
      const inventory = await syncSquareInventoryCatalogForSalon(salonId);
      if (unhealthyWorkerResult(inventory, HEALTHY_INVENTORY_STATUSES)) {
        throw new Error("square_inventory_sync_unhealthy");
      }
      // Square EMAIL-consent sync is too heavy (paginates ALL customers) for this
      // 60s cron — it now runs on its own daily cron /api/cron/square-email-consent.
      results[salonId] = { ...sync, deposits, noShowFees, visits, inventory };
    } catch (e) {
      const msg = stableSalonFailure(e);
      console.error("[square-sync] salon", salonId, msg);
      const { error: healthWriteError } = await supabase
        .from("square_integrations")
        .update({ last_error: msg, last_run_at: new Date().toISOString() })
        .eq("salon_id", salonId);
      failedSalons++;
      if (healthWriteError) {
        console.error("[square-sync] failed to persist salon error", salonId);
        results[salonId] = { error: "square_sync_health_write_failed" };
      } else {
        results[salonId] = { error: msg };
      }
    }

    // AI agents (watchdog, winback, rebook, noshow backfill) moved to
    // /api/cron/manager — runs hourly across ALL salons, not just Square ones.
  }

    const ok = failedSalons === 0 && !globalWorkerUnhealthy;
    return NextResponse.json({
      ok,
      ...(globalWorkerUnhealthy
        ? {
            error: "square_sync_global_worker_unhealthy",
            inventoryRecovery: redactWorkerResults(inventoryRecovery),
            optionalWebhookWorkers: Object.fromEntries(
              Object.entries(optionalWebhookWorkers).map(([capability, workerResults]) => [
                capability,
                redactWorkerResults(workerResults),
              ]),
            ),
          }
        : { inventoryRecovery, optionalWebhookWorkers }),
      results,
    }, { status: ok ? 200 : 500 });
  });
}
