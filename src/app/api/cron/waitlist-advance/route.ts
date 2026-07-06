/**
 * Expires stale waitlist claim links and notifies the next person in line.
 * Called every 5 minutes by Vercel Cron.
 *
 * The DB RPC `advance_waitlist_notifications` atomically:
 *   1. Flips 'notified' entries whose claim window expired → 'expired'
 *   2. Flags the next 'waiting' entry → 'notified' (new claim_token)
 *   3. Returns each promoted row so we can send the outbound notification.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { notifyWaitlistForSlot } from "@/shared/noshow/waitlistAutoFill";
import { refundRefilledLateCancels } from "@/shared/integrations/square/noshow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minutes a claim link stays live before the next person is notified. */
const CLAIM_WINDOW_MINUTES = 20;

export async function GET(req: NextRequest) {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createServiceRoleClient();

  const { data, error } = await supabase.rpc("advance_waitlist_notifications", {
    p_window_minutes: CLAIM_WINDOW_MINUTES,
  });

  if (error) {
    console.error("[waitlist-advance] RPC failed", error);
    return NextResponse.json({ error: "rpc_failed" }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    salon_id: string;
    service_id: string;
    booking_date: string;
    salon_name: string;
    service_name: string;
  }>;

  let advanced = 0;

  for (const row of rows) {
    try {
      await notifyWaitlistForSlot({
        salonId: row.salon_id,
        salonName: row.salon_name,
        serviceId: row.service_id,
        serviceName: row.service_name,
        bookingDateYmd: String(row.booking_date).slice(0, 10),
      });
      advanced += 1;
    } catch (e) {
      console.error(
        "[waitlist-advance] notify failed for slot",
        { salon_id: row.salon_id, service_id: row.service_id, booking_date: row.booking_date },
        e,
      );
    }
  }

  // Fair Cancel: refund late-cancel fees whose freed slot has since been
  // rebooked (best-effort; never fails the waitlist advance).
  let refunded = 0;
  try {
    const r = await refundRefilledLateCancels();
    refunded = r.refunded;
  } catch (e) {
    console.error("[waitlist-advance] late-cancel refund pass failed", e);
  }

  return NextResponse.json({ ok: true, advanced, refunded });
}
