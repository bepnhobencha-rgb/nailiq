import { NextResponse } from "next/server";
import { runDueCampaigns } from "@/shared/reoptin/campaignSchedule";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Fires scheduled marketing campaigns whose time has arrived. Runs every 15 min
 * (see vercel.json). Secured by CRON_SECRET — Vercel Cron sends it automatically
 * as a Bearer token.
 */
export async function GET(req: Request) {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await runDueCampaigns();
  return NextResponse.json({ ok: true, ...result });
}
