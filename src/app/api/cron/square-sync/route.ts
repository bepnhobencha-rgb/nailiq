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
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("square_sync", async () => {

  const supabase = looseServiceClient();
  const { data: integrations, error } = await supabase
    .from("square_integrations")
    .select("salon_id")
    .eq("enabled", true)
    .not("access_token", "is", null);

  if (error) {
    console.error("[square-sync] load integrations", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const results: Record<string, unknown> = {};
  for (const it of integrations ?? []) {
    const salonId = it.salon_id as string;
    try {
      const sync = await runSquareForwardSync(salonId);
      const deposits = await reconcileDeposits(salonId);
      const noShowFees = await reconcileNoShowFeeLinks(salonId);
      const visits = await syncSquareVisitHistory(salonId);
      // Square EMAIL-consent sync is too heavy (paginates ALL customers) for this
      // 60s cron — it now runs on its own daily cron /api/cron/square-email-consent.
      results[salonId] = { ...sync, deposits, noShowFees, visits };
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[square-sync] salon", salonId, msg);
      results[salonId] = { error: msg };
      await supabase
        .from("square_integrations")
        .update({ last_error: msg, last_run_at: new Date().toISOString() })
        .eq("salon_id", salonId);
    }

    // AI agents (watchdog, winback, rebook, noshow backfill) moved to
    // /api/cron/manager — runs hourly across ALL salons, not just Square ones.
  }

    return NextResponse.json({ ok: true, results });
  });
}
