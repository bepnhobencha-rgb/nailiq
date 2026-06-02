// POST /api/booking/wix-create
// Pushes a new NailIQ booking to the Wix calendar (best-effort write-back).
// Called fire-and-forget from submitPublicBooking (client-side) after a
// successful booking creation.  Uses service-role so it must stay server-only.

import { NextResponse } from "next/server";
import { pushWixCreate } from "@/shared/integrations/wix/writeback";

export const dynamic = "force-dynamic";

/** Loose UUID shape — good enough to block obviously invalid inputs. */
function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s.trim(),
  );
}

export async function POST(req: Request) {
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

  // Best-effort: never throw — the caller does not await this route.
  await pushWixCreate(salonId, bookingId);

  return NextResponse.json({ ok: true });
}
