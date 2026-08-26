import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The legacy quick-rebook API accepted only a salon id and phone number before
 * using service-role access to read booking history or create a confirmed
 * booking. The supported rebook experience now proves phone ownership through
 * OTP, pre-fills the regular booking flow, and submits through its normal
 * authorization and idempotency boundary.
 *
 * Keep this old URL fail-closed so stale clients cannot regain the privileged
 * behavior while making it explicit that the endpoint is intentionally gone.
 */
function gone() {
  return NextResponse.json(
    { ok: false, error: "gone" },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export function GET() {
  return gone();
}

export function POST() {
  return gone();
}
