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
  }

  return NextResponse.json({ ok: true, results });
}
