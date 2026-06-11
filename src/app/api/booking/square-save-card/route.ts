import { NextRequest, NextResponse } from "next/server";
import { saveNoShowCardForBooking } from "@/shared/integrations/square/noshow";

export const runtime = "nodejs";

/**
 * POST /api/booking/square-save-card
 * Body: { bookingId, sourceId } — sourceId is the Web Payments SDK card token.
 * Saves the card on file (no charge) so a no-show fee can be taken later.
 */
export async function POST(req: NextRequest) {
  let body: { bookingId?: string; sourceId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const bookingId = String(body.bookingId ?? "");
  const sourceId = String(body.sourceId ?? "");
  if (!bookingId || !sourceId) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }
  try {
    const r = await saveNoShowCardForBooking(bookingId, sourceId);
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  } catch (e) {
    console.error("[square-save-card] error", e);
    // Never leak internals; the card step is best-effort and must not block booking.
    return NextResponse.json({ ok: false, error: "save_failed" }, { status: 500 });
  }
}
