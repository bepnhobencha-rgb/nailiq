/**
 * Forward-syncs Square bookings into NailIQ for every enabled `square_integrations`
 * row. Called by Vercel Cron (see vercel.json). Secured by CRON_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { looseServiceClient } from "@/shared/integrations/square/looseDb";
import { runSquareForwardSync } from "@/shared/integrations/square/sync";
import { reconcileDeposits } from "@/shared/integrations/square/deposits";
import { reconcileNoShowFeeLinks } from "@/shared/integrations/square/noshow";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
      results[salonId] = { ...sync, deposits, noShowFees };
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[square-sync] salon", salonId, msg);
      results[salonId] = { error: msg };
      await supabase
        .from("square_integrations")
        .update({ last_error: msg, last_run_at: new Date().toISOString() })
        .eq("salon_id", salonId);
    }

    // AI no-show policy agent (shadow OR live) — runs INDEPENDENTLY of the Square
    // pull so a sync error never blocks it. Square-origin bookings never hit the
    // NailIQ online hook, so evaluate a few here each run (self-gated on the
    // salon's opt-in flag; in live mode it sets the card flag). Best-effort.
    try {
      const { backfillNoShowShadow } = await import("@/shared/noshow/agentNoShowPolicy");
      await backfillNoShowShadow(salonId);
    } catch (e) {
      console.error("[square-sync] shadow backfill", salonId, e);
    }

    // AI Watchdog — proactive owner alerts. Self-throttles to ~once/12h and
    // self-gates on the salon's ai_watchdog flag, so it's cheap to call every
    // run. Independent of the sync result. Best-effort.
    try {
      const { runWatchdog } = await import("@/shared/watchdog/agentWatchdog");
      await runWatchdog(salonId);
    } catch (e) {
      console.error("[square-sync] watchdog", salonId, e);
    }
  }

  return NextResponse.json({ ok: true, results });
}
