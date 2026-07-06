import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendOwnerWaitlistNotification } from "@/shared/dashboard/sendOwnerBookingNotification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fire-and-forget from the public waitlist-join flow: emails the salon owner/
 * admins that a customer joined the waitlist. salon_id is derived from the entry
 * (not trusted from the client), and the notification is gated by the salon's
 * owner_notification_settings.enabled toggle.
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

  await sendOwnerWaitlistNotification(salonId, waitlistId);
  return NextResponse.json({ ok: true });
}
