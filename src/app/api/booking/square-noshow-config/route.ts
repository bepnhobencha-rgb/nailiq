import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { noShowCardDecision } from "@/shared/integrations/square/noshow";
import { getSquareConfig } from "@/shared/integrations/square/client";

export const runtime = "nodejs";

/**
 * GET /api/booking/square-noshow-config?bookingId=<uuid>
 * Tells the success screen whether to ask for a card-on-file and returns the
 * PUBLIC Web Payments SDK params (application id + location + environment).
 * Returns { required:false } whenever the feature is off / not configured.
 */
export async function GET(req: NextRequest) {
  const bookingId = new URL(req.url).searchParams.get("bookingId") ?? "";
  if (!bookingId) return NextResponse.json({ required: false });

  try {
    const decision = await noShowCardDecision(bookingId);
    if (!decision.required) return NextResponse.json({ required: false });

    // Resolve the salon to load its public SDK params.
    const db = createServiceRoleClient();
    const { data: b } = await db
      .from("bookings")
      .select("salon_id")
      .eq("id", bookingId)
      .maybeSingle();
    const salonId = (b as { salon_id?: string } | null)?.salon_id;
    if (!salonId) return NextResponse.json({ required: false });

    const cfg = await getSquareConfig(db, salonId);
    if (!cfg.applicationId) return NextResponse.json({ required: false });

    return NextResponse.json({
      required: true,
      feeCents: decision.feeCents,
      applicationId: cfg.applicationId,
      locationId: cfg.locationId,
      environment: cfg.environment,
    });
  } catch (e) {
    console.error("[square-noshow-config]", e);
    return NextResponse.json({ required: false });
  }
}
