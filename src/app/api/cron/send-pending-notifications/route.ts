/**
 * Drains independently leased notification workers. The legacy
 * `scheduled_notifications` queue is observed only for migration visibility;
 * it is never rendered from mutable booking rows or marked sent.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";
import { deliverPendingPlatformAnnouncementEmails } from "@/shared/superadmin/platformAnnouncementEmail";
import { runCustomerBookingTransitionEmailWorker } from "@/shared/notifications/customerBookingTransitionEmail";
import { runBookingConfirmationRetryWorker } from "@/shared/booking/bookingConfirmationRetryDelivery";
import { runStaffActionNotificationWorker } from "@/shared/notifications/staffActionNotificationWorker";
import { runOwnerBookingNotificationWorker } from "@/shared/notifications/ownerBookingNotificationWorker";
import { runOwnerWaitlistNotificationWorker } from "@/shared/notifications/ownerWaitlistNotificationWorker";

export const runtime = "nodejs";
export const maxDuration = 55;

const BATCH = 100;
const BOOKING_CONFIRMATION_RETRY_BATCH = 10;
const CUSTOMER_TRANSITION_BATCH = 10;
const STAFF_ACTION_DELIVERY_BATCH = 10;
const OWNER_BOOKING_NOTIFICATION_BATCH = 10;
const OWNER_WAITLIST_NOTIFICATION_BATCH = 10;

export async function GET(req: NextRequest) {
  const authorizationError = requireCronAuthorization(req);
  if (authorizationError) return authorizationError;
  return runTrackedCron("send_pending_notifications", async () => {

  const supabase = createServiceRoleClient();
  const nowIso = new Date().toISOString();

  // Staff-action notifications have their own immutable occurrence/envelope
  // contract. Drain it before observing the retired mutable legacy queue.
  const staffActionNotifications =
    await runStaffActionNotificationWorker(STAFF_ACTION_DELIVERY_BATCH);

  // Booking/reschedule manager alerts are recorded transactionally by the
  // bookings trigger. This leased worker is the only catch-up path when a
  // request finishes before its best-effort inline sender runs.
  const ownerBookingNotifications =
    await runOwnerBookingNotificationWorker(OWNER_BOOKING_NOTIFICATION_BATCH);

  // Public waitlist joins are captured atomically by their own outbox trigger.
  // Drain them separately so a booking-email backlog cannot starve waitlist
  // attention and so no public request ever calls Resend inline.
  const ownerWaitlistNotifications =
    await runOwnerWaitlistNotificationWorker(OWNER_WAITLIST_NOTIFICATION_BATCH);

  // Confirmation retries have a strict 30-minute window. Drain their small,
  // independently leased batch before the legacy 100-row sequential queue so
  // a scheduled-notification backlog cannot starve every retry invocation.
  const bookingConfirmationRetries =
    await runBookingConfirmationRetryWorker(BOOKING_CONFIRMATION_RETRY_BATCH);

  const { data: due, error } = await supabase
    .from("scheduled_notifications")
    .select("id, salon_id, booking_id, event, channels")
    .eq("status", "pending")
    .lte("send_after", nowIso)
    .order("send_after", { ascending: true })
    .limit(BATCH);

  if (error) {
    console.error("[send-pending-notifications]", error);
  }

  // Rows written by the retired queue have no immutable occurrence snapshot or
  // provider lease. Never infer a new envelope from today's booking/salon row
  // and never mark them sent without a provider receipt.
  const legacyStaffActionPending = error ? null : (due?.length ?? 0);

    const platformNotices = await deliverPendingPlatformAnnouncementEmails(
      supabase,
    );
    const customerTransitionEmails =
      await runCustomerBookingTransitionEmailWorker(CUSTOMER_TRANSITION_BATCH);

    return NextResponse.json({
      ok: true,
      claimed: 0,
      smsCount: 0,
      emailCount: 0,
      legacyStaffActionPending,
      staffActionNotifications,
      ownerBookingNotifications,
      ownerWaitlistNotifications,
      platformNotices,
      bookingConfirmationRetries,
      customerTransitionEmails,
    });
  });
}
