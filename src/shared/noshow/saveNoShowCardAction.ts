"use server";

import { reuseNoShowCardForBooking } from "@/shared/integrations/square/noshow";
import { durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";

/** Retired unscoped entry point. New captures use the expiring management
 * capability route; a booking ID alone grants no mutation authority. */
export async function saveNoShowCardAction(args: {
  bookingId: string;
  sourceId: string;
  consent: boolean;
  verificationToken?: string;
}): Promise<{ ok: boolean; reason: string; last4?: string }> {
  // An unscoped booking ID must neither call a provider nor flag someone else's booking.
  void args;
  return { ok: false, reason: "management_capability_required" };
}

/** OTP-authenticated reuse. A failed identity check never changes a booking.
 * Successful Square reuse commits a verified read receipt atomically. */
export async function reuseNoShowCardAction(args: {
  bookingId: string;
  otpSessionId: string;
  consent: boolean;
}): Promise<{ ok: boolean; reason: string; last4?: string }> {
  try {
    if (await isOverRateLimit(durableRateLimitKey("card-reuse", args.bookingId), 6, 300, { failureMode:"block" })) return { ok:false,reason:"card_reuse_unavailable" };
    const r = await reuseNoShowCardForBooking(args.bookingId, args.otpSessionId, args.consent);
    if (r.ok) return r;

    return r;
  } catch {
    return { ok: false, reason: "card_reuse_failed" };
  }
}
