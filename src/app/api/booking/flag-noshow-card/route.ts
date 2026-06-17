import { NextRequest, NextResponse } from "next/server";
import { ensureNoShowCardRequirement } from "@/shared/noshow/ensureNoShowCardRequirement";

export const runtime = "nodejs";

/**
 * POST /api/booking/flag-noshow-card  { bookingId }
 *
 * Runs the unified no-show card gate for a just-created booking. The online
 * GROUP wizard runs in the browser, so it can't import the server-only gate
 * directly (other paths flag server-side at creation) — it calls this instead.
 *
 * Low-risk + idempotent: ensureNoShowCardRequirement only SETS the
 * `noshow_card_required` flag (no charge, no cancel, no data returned) and
 * applies the same risk gate as every other path, so it self-skips when the
 * customer doesn't need a card. Mirrors the existing bookingId-keyed booking
 * endpoints (square-noshow-config / square-save-card).
 */
export async function POST(req: NextRequest) {
  let body: { bookingId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }
  const bookingId = String(body.bookingId ?? "").trim();
  if (!bookingId) {
    return NextResponse.json({ ok: false, error: "missing_booking" }, { status: 400 });
  }

  const result = await ensureNoShowCardRequirement(bookingId);
  return NextResponse.json({ ok: true, required: result.required });
}
