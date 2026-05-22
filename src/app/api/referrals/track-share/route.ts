import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/referrals/track-share
 * Body: { salon_id, phone, channel }
 *
 * Lightweight analytics event — records which channel a referral link was shared via.
 * No PII stored beyond what's already in the referrals row.
 * Currently logs to console; extend later with a proper events table.
 */
export async function POST(req: Request) {
  let body: { salon_id?: string; phone?: string; channel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const { salon_id, phone, channel } = body;

  // Structured log — picked up by Vercel Log Drains / Supabase Logs
  console.log(
    JSON.stringify({
      event: "referral_share",
      salon_id: salon_id ?? null,
      phone_last4: phone ? phone.slice(-4) : null,
      channel: channel ?? "unknown",
      ts: new Date().toISOString(),
    }),
  );

  return NextResponse.json({ ok: true });
}
