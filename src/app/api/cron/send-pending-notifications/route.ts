/**
 * Delivers due staff-action customer notifications from `scheduled_notifications`.
 * Called every minute by Vercel Cron. Each row is CLAIMED atomically
 * (pending → sent) before delivery so overlapping runs can't double-send; a
 * delivery failure is logged but the row stays claimed (best-effort, no retry
 * storm for a cancellation notice).
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { deliverStaffActionNotification } from "@/shared/notifications/deliverStaffActionNotification";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";

export const runtime = "nodejs";
export const maxDuration = 55;

const BATCH = 100;

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;

  const supabase = createServiceRoleClient();
  const nowIso = new Date().toISOString();

  const { data: due, error } = await supabase
    .from("scheduled_notifications")
    .select("id, salon_id, booking_id, event, channels")
    .eq("status", "pending")
    .lte("send_after", nowIso)
    .order("send_after", { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error("[send-pending-notifications]", error);
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }

  let delivered = 0;
  let smsCount = 0;
  let emailCount = 0;

  for (const rowRaw of due ?? []) {
    const row = rowRaw as unknown as {
      id: string;
      salon_id: string;
      booking_id: string;
      event: "create" | "reschedule" | "cancel";
      channels: { sms?: boolean; email?: boolean } | null;
    };

    // Claim atomically: only proceed if THIS run flips pending → sent.
    const { data: claimed } = await supabase
      .from("scheduled_notifications")
      .update({ status: "sent", sent_at: new Date().toISOString() } as never)
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) continue; // another run got it (or it was cancelled)

    try {
      const res = await deliverStaffActionNotification(supabase, {
        salonId: row.salon_id,
        bookingId: row.booking_id,
        event: row.event,
        channels: row.channels ?? {},
      });
      delivered += 1;
      if (res.smsSent) smsCount += 1;
      if (res.emailSent) emailCount += 1;
    } catch (e) {
      console.error("[send-pending-notifications] deliver failed", row.id, e);
    }
  }

  return NextResponse.json({ ok: true, claimed: delivered, smsCount, emailCount });
}
