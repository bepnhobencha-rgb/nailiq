"use server";

import { after } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  sendOwnerBookingNotification,
  type OwnerNotifyInput,
} from "@/shared/dashboard/sendOwnerBookingNotification";

/**
 * Post-creation field stamps for GROUP bookings.
 *
 * Why this is needed: `submitGroupBooking` runs in the BROWSER for the public
 * flow (it writes through the anon Supabase client). Anon holds the UPDATE
 * grant on `bookings` but has no RLS UPDATE policy, so a client-side
 * `.update()` on a booking row affects 0 rows and returns no error — the same
 * silent failure `publicBookingSideEffects` was created to fix for the
 * individual flow. The group flow never got an equivalent, which left every
 * group row with `booking_channel = null` and no verification stamp. Service
 * role bypasses RLS.
 *
 * Deliberately a separate action rather than a new branch inside
 * `publicBookingSideEffects`: that one runs on every individual online booking
 * (risk scoring, confirmation email, referral claim). Widening it to also carry
 * the group shape would put the individual booking path at risk for no gain.
 *
 * The scope split below is intentional:
 *   - `booking_channel` is stamped on EVERY member row. Each row really was
 *     created through that channel, and reports group by it per row — stamping
 *     only the organizer would leave members invisible, which is the bug.
 *   - verification is stamped on the ORGANIZER row only. The OTP verified the
 *     organizer's phone; members carry no contact of their own, so marking each
 *     of them independently verified would overstate the evidence. This mirrors
 *     the rule `submitGroupBooking` already applies to sms_consent ("stamped on
 *     the organizer's booking alone, not fanned out across the party").
 */
export async function stampGroupBookingIdentity(args: {
  /** Every booking row in the party, organizer included. */
  bookingIds: string[];
  /** The organizer's row — the one carrying verification evidence. */
  organizerBookingId?: string | null;
  /** How the party was booked: 'online' (public flow) | 'desk' (receptionist). */
  bookingChannel: string;
  /** Present when the salon has phone_otp_enabled and the organizer verified. */
  otpSessionId?: string | null;
  /** Owner/manager "new booking" alert for the whole party. Dispatched here for
   *  the same reason as the stamps: submitGroupBooking runs in the BROWSER, so
   *  the sender's service-role client threw and its catch swallowed it — no
   *  group booking ever produced an owner alert. */
  ownerNotify?: OwnerNotifyInput;
}): Promise<void> {
  const ids = args.bookingIds.filter(
    (id) => typeof id === "string" && id.trim().length > 0,
  );
  const channel = args.bookingChannel.trim();
  if (ids.length === 0 || channel.length === 0) return;

  after(async () => {
    if (args.ownerNotify) {
      await sendOwnerBookingNotification(args.ownerNotify).catch((e) =>
        console.error("[groupBookingSideEffects] owner notify threw", e),
      );
    }
    const db = createServiceRoleClient();

    const { error: channelErr } = await db
      .from("bookings" as never)
      .update({ booking_channel: channel } as never)
      .in("id", ids);
    if (channelErr) {
      console.error("[groupBookingSideEffects] channel stamp", channelErr);
    }

    // Only claim verification when an OTP session actually backs it.
    if (args.organizerBookingId && args.otpSessionId) {
      const { error: verifyErr } = await db
        .from("bookings" as never)
        .update({
          verification_method: "otp",
          verification_completed_at: new Date().toISOString(),
          otp_session_id: args.otpSessionId,
        } as never)
        .eq("id", args.organizerBookingId);
      if (verifyErr) {
        console.error("[groupBookingSideEffects] verification stamp", verifyErr);
      }
    }
  });
}
