"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { syncSquareVisitHistory, type VisitSyncResult } from "@/shared/integrations/square/visitSync";

/**
 * Owner-triggered: full backfill of per-visit history from Square payments into
 * square_visit_history. Run once after initial setup; the square-sync cron handles
 * incremental updates from then on.
 */
export async function syncSquareVisitHistoryAction(slug: string): Promise<VisitSyncResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || ctx.role !== "owner") {
    return { ok: false, paymentsScanned: 0, upserted: 0, withServices: 0, error: "unauthorized" };
  }
  return syncSquareVisitHistory(ctx.salon.id, { fullBackfill: true });
}
