"use server";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { syncSquareSpend } from "@/shared/integrations/square/spendSync";

/**
 * Owner-triggered: pull each customer's lifetime spend from Square into
 * `salon_client_spend` (foundation for VIP / spend-loyalty programs). Owner-only
 * (it reads the salon's Square payments).
 */
export async function syncSquareSpendAction(slug: string): Promise<{
  ok: boolean;
  squareCustomers?: number;
  matchedProfiles?: number;
  totalCents?: number;
  error?: string;
}> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || ctx.role !== "owner") return { ok: false, error: "unauthorized" };
  return syncSquareSpend(ctx.salon.id);
}
