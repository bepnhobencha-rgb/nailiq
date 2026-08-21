// POST /api/booking/wix-create
// Pushes a new NailIQ booking to the Wix calendar (best-effort write-back).
// Called fire-and-forget from submitPublicBooking (client-side) after a
// successful booking creation.  Uses service-role so it must stay server-only.

import { NextResponse } from "next/server";
import { pushWixCreate } from "@/shared/integrations/wix/writeback";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

export const dynamic = "force-dynamic";

/** Loose UUID shape — good enough to block obviously invalid inputs. */
function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s.trim(),
  );
}

export async function POST(req: Request) {
  const ipRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "booking-wix-create",
    ipLimits: [[10, 60], [60, 3_600]],
  });
  if (ipRate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: ipRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: ipRate === "limited" ? 429 : 503 },
    );
  }
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: false }, { status: 400 });

  const { bookingId, salonId } = body as {
    bookingId?: string;
    salonId?: string;
  };

  if (
    typeof bookingId !== "string" ||
    typeof salonId !== "string" ||
    !isUuidLike(bookingId) ||
    !isUuidLike(salonId)
  ) {
    // Return 200 so the fire-and-forget fetch in the browser doesn't log noise.
    return NextResponse.json({ ok: false, error: "invalid_params" });
  }

  const bookingRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "booking-wix-create-booking",
    identity: [salonId, bookingId],
    ipLimits: [],
    identityLimits: [[3, 3_600], [5, 86_400]],
  });
  if (bookingRate !== "allowed") {
    return NextResponse.json(
      { ok: false, error: bookingRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: bookingRate === "limited" ? 429 : 503 },
    );
  }

  // Best-effort: never throw — the caller does not await this route.
  await pushWixCreate(salonId, bookingId);

  return NextResponse.json({ ok: true });
}
