// POST /api/booking/wix-conflict
// Real-time Wix slot conflict check before NailIQ confirms a booking.
// Called synchronously from submitPublicBooking (client-side) for salons
// that have a Wix integration with a mapped staff resource.
//
// Fail-open: any error returns { conflict: false } so a Wix outage never
// blocks the NailIQ booking flow.

import { NextResponse } from "next/server";
import { checkWixSlotConflict } from "@/shared/integrations/wix/client";
import { looseServiceClient } from "@/shared/integrations/wix/looseDb";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

export const dynamic = "force-dynamic";

function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s.trim(),
  );
}

function isIsoDate(s: string): boolean {
  return !isNaN(Date.parse(s));
}

export async function POST(req: Request) {
  try {
    const ipRate = await consumePublicRequestRateLimit({
      request: req,
      scope: "booking-wix-conflict",
      ipLimits: [[20, 60], [100, 3_600]],
    });
    if (ipRate !== "allowed") {
      return NextResponse.json(
        { conflict: false, error: ipRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
        { status: ipRate === "limited" ? 429 : 503 },
      );
    }
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ conflict: false });

    const { salonId, staffId, startTimeUtc, endTimeUtc } = body as {
      salonId?: string;
      staffId?: string;
      startTimeUtc?: string;
      endTimeUtc?: string;
    };

    // Basic validation — missing or invalid params → skip check (fail open).
    if (
      typeof salonId !== "string" || !isUuidLike(salonId) ||
      typeof staffId !== "string" || !isUuidLike(staffId) ||
      typeof startTimeUtc !== "string" || !isIsoDate(startTimeUtc) ||
      typeof endTimeUtc !== "string" || !isIsoDate(endTimeUtc)
    ) {
      return NextResponse.json({ conflict: false });
    }

    const salonRate = await consumePublicRequestRateLimit({
      request: req,
      scope: "booking-wix-conflict-salon",
      identity: [salonId, staffId],
      ipLimits: [],
      identityLimits: [[60, 300], [300, 3_600]],
    });
    if (salonRate !== "allowed") {
      return NextResponse.json(
        { conflict: false, error: salonRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
        { status: salonRate === "limited" ? 429 : 503 },
      );
    }

    const db = looseServiceClient();

    // 1. Check if the salon has an enabled Wix integration.
    const { data: rawInteg } = await db
      .from("wix_integrations")
      .select("site_id")
      .eq("salon_id", salonId)
      .eq("enabled", true)
      .maybeSingle();
    const siteId = (rawInteg as { site_id?: string } | null)?.site_id;
    if (!siteId) return NextResponse.json({ conflict: false });

    // 2. Look up the staff's Wix resource ID.
    const { data: rawStaff } = await db
      .from("staff")
      .select("wix_resource_id")
      .eq("id", staffId)
      .eq("salon_id", salonId)
      .maybeSingle();
    const wixResourceId = (rawStaff as { wix_resource_id?: string | null } | null)?.wix_resource_id;
    if (!wixResourceId) return NextResponse.json({ conflict: false });

    // 3. Query Wix Extended Bookings API for an overlapping active booking.
    const conflict = await checkWixSlotConflict(
      siteId,
      wixResourceId,
      new Date(startTimeUtc).toISOString(),
      new Date(endTimeUtc).toISOString(),
    );

    return NextResponse.json({ conflict });
  } catch {
    // Fail open — never block the booking flow due to a server error.
    return NextResponse.json({ conflict: false });
  }
}
