import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compatibility acknowledgement for clients deployed before the durable
 * Waitlist-owner outbox. The database trigger already queued the notification
 * in the same transaction as the Waitlist INSERT. This route must never call a
 * provider or create a second delivery intent.
 */
export async function POST(req: Request) {
  const { waitlistId } = await req.json().catch(() => ({}));
  if (!waitlistId || typeof waitlistId !== "string") {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const admin = createServiceRoleClient();
  const { data } = await admin
    .from("booking_waitlist_entries")
    .select("salon_id")
    .eq("id", waitlistId)
    .maybeSingle();
  const salonId = (data as { salon_id?: string } | null)?.salon_id;
  if (!salonId) return NextResponse.json({ ok: false }, { status: 404 });

  return NextResponse.json({ ok: true, queued: true });
}
