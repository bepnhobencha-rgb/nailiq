// POST /api/booking/set-ref-image
// Fire-and-forget after booking creation.
// Associates a pre-uploaded reference image path with a booking.

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ipRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "booking-reference-attach",
    ipLimits: [[20, 60], [100, 3_600]],
  });
  if (ipRate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: ipRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: ipRate === "limited" ? 429 : 503 },
    );
  }
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: false }, { status: 400 });

  const { bookingId, refPath } = body as { bookingId?: string; refPath?: string };
  if (!bookingId || !refPath) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  const bookingRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "booking-reference-attach-booking",
    identity: [bookingId, refPath],
    ipLimits: [],
    identityLimits: [[3, 3_600], [5, 86_400]],
  });
  if (bookingRate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: bookingRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: bookingRate === "limited" ? 429 : 503 },
    );
  }

  // Basic path sanity — must look like {uuid}/{uuid}.{ext}
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(refPath)) {
    return NextResponse.json({ ok: false, error: "invalid_path" }, { status: 400 });
  }

  const db = createServiceRoleClient();
  const { error } = await db
    .from("bookings")
    .update({ reference_image_path: refPath } as never)
    .eq("id", bookingId);

  if (error) {
    console.error("[set-ref-image] update error", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
