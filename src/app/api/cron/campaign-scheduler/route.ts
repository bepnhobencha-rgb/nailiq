import { NextResponse } from "next/server";
import { runDueCampaigns } from "@/shared/reoptin/campaignSchedule";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Fires scheduled marketing campaigns whose time has arrived. Runs every 15 min
 * (see vercel.json). Secured by CRON_SECRET — Vercel Cron sends it automatically
 * as a Bearer token.
 */
export async function GET(req: Request) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  const result = await runDueCampaigns();
  return NextResponse.json({ ok: true, ...result });
}
