import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retired privileged deposit attachment boundary.
 *
 * The legacy route accepted a caller-selected booking id, PaymentIntent id,
 * and connected account before writing financial truth directly to the
 * booking. Public deposits now finalize and bind through the durable payment
 * operation ledger, which owns the canonical booking intent, provider receipt,
 * and exact replay semantics.
 *
 * Keep the old URL permanently fail-closed for stale clients. Do not parse the
 * body or construct a provider/database client here.
 */
export function POST() {
  return NextResponse.json(
    { ok: false, error: "gone" },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
