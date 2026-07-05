import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { syncSquareSpend } from "@/shared/integrations/square/spendSync";

/**
 * Daily: refresh every Square-connected salon's per-customer lifetime spend into
 * `salon_client_spend`, so "Tổng chi" / Top-spenders / VIP-by-spend stay current
 * instead of frozen at the one-off backfill. syncSquareSpend re-pages ALL Square
 * payments (heavy), so this runs once a day off-peak — NOT the 5-min square-sync
 * cron (which handles bookings/customers). Each salon self-guards via
 * getSquareConfig, so an unconfigured/disconnected row is skipped, not fatal.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const db = createServiceRoleClient();
  const { data: integrations, error } = await db
    .from("square_integrations")
    .select("salon_id");
  if (error) {
    return NextResponse.json({ error: "load_integrations_failed" }, { status: 500 });
  }

  const salonIds = [
    ...new Set(
      ((integrations as { salon_id: string }[] | null) ?? [])
        .map((r) => r.salon_id)
        .filter(Boolean),
    ),
  ];

  let synced = 0;
  let failed = 0;
  let totalCents = 0;
  const results: { salonId: string; ok: boolean; matchedProfiles?: number; error?: string }[] = [];

  // Sequential — each sync pages the full Square payment history; running them in
  // parallel risks the 300s ceiling and Square rate limits for little gain (few salons).
  for (const salonId of salonIds) {
    try {
      const r = await syncSquareSpend(salonId);
      if (r.ok) {
        synced += 1;
        totalCents += r.totalCents;
        results.push({ salonId, ok: true, matchedProfiles: r.matchedProfiles });
      } else {
        failed += 1;
        results.push({ salonId, ok: false, error: r.error });
      }
    } catch (e) {
      failed += 1;
      results.push({ salonId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    salons: salonIds.length,
    synced,
    failed,
    totalDollars: Math.round(totalCents / 100),
    results,
  });
}
