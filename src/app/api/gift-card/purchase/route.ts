import { NextResponse } from "next/server";

/**
 * Permanently retire the legacy public free-mint implementation.
 *
 * Gift Card issuance may return here only after a new route is bound to the
 * durable Square create -> completed payment -> activation receipt chain. A
 * feature flag must never be able to resurrect local voucher value.
 */
export async function POST() {
  return NextResponse.json({ error: "gift_cards_unavailable" }, { status: 503 });
}
