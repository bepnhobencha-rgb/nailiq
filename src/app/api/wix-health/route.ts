/**
 * TEMPORARY connectivity probe — verifies this Vercel deployment can reach the Wix
 * Bookings API with the WIX_API_KEY env var. Returns only reachability + a count,
 * never any booking data or the key. Remove after the preview test.
 */
import { NextResponse } from "next/server";
import { queryBookingsUpdatedSince } from "@/shared/integrations/wix/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TECH_NAILS_SITE = "bca289a2-f279-4a9a-a484-c036e5f78a34";

export async function GET() {
  if (!process.env.WIX_API_KEY) {
    return NextResponse.json({ ok: false, reachable: false, reason: "WIX_API_KEY not set in this environment" });
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const bookings = await queryBookingsUpdatedSince(TECH_NAILS_SITE, since);
    return NextResponse.json({ ok: true, reachable: true, sampleCount: bookings.length, since });
  } catch (e) {
    return NextResponse.json({ ok: false, reachable: false, error: (e as Error).message });
  }
}
