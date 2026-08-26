/**
 * Forward-syncs Wix bookings into NailIQ for every enabled `wix_integrations` row.
 * Called every ~2 minutes by Vercel Cron (see vercel.json). Secured by CRON_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { runForwardSync } from "@/shared/integrations/wix/sync";
import {
  pushUnsyncedBookings,
  reconcileWixLifecycleWritebacks,
} from "@/shared/integrations/wix/writeback";
import { looseServiceClient } from "@/shared/integrations/wix/looseDb";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("wix_sync", async () => {
  if (!process.env.WIX_API_KEY) {
    return NextResponse.json({ ok: false, error: "WIX_API_KEY not set" }, { status: 500 });
  }

  const supabase = looseServiceClient();
  const { data: integrations, error } = await supabase
    .from("wix_integrations")
    .select("salon_id, site_id, cursor_updated_date, auto_approve")
    .eq("enabled", true);

  if (error) {
    console.error("[wix-sync] load integrations", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const results: Record<string, unknown> = {};
  for (const it of integrations ?? []) {
    const salonId = it.salon_id as string;
    try {
      const r = await runForwardSync(salonId, it.site_id as string, it.cursor_updated_date as string, (it.auto_approve as boolean) ?? true);
      // Reconcile NailIQ→Wix: push any eligible booking whose immediate create-push was missed.
      const reconciled = await pushUnsyncedBookings(salonId);
      const lifecycleReconciled = await reconcileWixLifecycleWritebacks(salonId);
      results[salonId] = { ...r, reconciled, lifecycleReconciled };
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[wix-sync] salon", salonId, msg);
      results[salonId] = { error: msg };
      await supabase.from("wix_integrations").update({ last_error: msg, last_run_at: new Date().toISOString() }).eq("salon_id", salonId);
    }
  }

    return NextResponse.json({ ok: true, results });
  });
}
