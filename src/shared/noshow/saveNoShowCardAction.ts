"use server";

import { saveNoShowCardForBooking, reuseNoShowCardForBooking } from "@/shared/integrations/square/noshow";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { ensureNoShowCardRequirement } from "@/shared/noshow/ensureNoShowCardRequirement";

/**
 * On a card save/reuse FAILURE, never cancel the booking — a system glitch
 * (Square lookup miss, network, declined verification) must not cost a real
 * customer their slot. Keep the booking and FLAG it `noshow_card_required` so
 * the desk collects a card later (the same "⚠️ needs card" badge + send-link
 * the desk already uses). Best-effort; never throws. Returns the original
 * failure so the caller can log it (but the caller must NOT block the booking).
 */
async function flagNeedsCard(bookingId: string): Promise<void> {
  await createServiceRoleClient()
    .from("bookings" as never)
    .update({ noshow_card_required: true } as never)
    .eq("id", bookingId)
    .then(
      () => {},
      () => {},
    );
}

/**
 * Defense-in-depth for public booking callers that submit without a card token.
 *
 * The normal confirmation UI blocks required-card bookings before creation.
 * This post-create check prevents a hand-crafted/browser-bypassed submission
 * from becoming silently unprotected: it re-derives the rule from production
 * data and flags the booking for desk follow-up when a card is still required.
 * It never charges, cancels, or blocks a real customer's booking.
 */
export async function ensureNoShowCardRequirementAction(
  bookingId: string,
): Promise<{ required: boolean; feeCents: number }> {
  return ensureNoShowCardRequirement(bookingId);
}

/**
 * Save the customer's card for a just-created booking (Option A: the card gate
 * runs INSIDE confirm, before SMS/email). On failure we DON'T cancel — we flag
 * the booking for the desk (see flagNeedsCard). Returns {ok}; the caller keeps
 * the booking either way.
 */
export async function saveNoShowCardAction(args: {
  bookingId: string;
  sourceId: string;
  consent: boolean;
  verificationToken?: string;
}): Promise<{ ok: boolean; reason: string; last4?: string }> {
  try {
    const r = await saveNoShowCardForBooking(
      args.bookingId,
      args.sourceId,
      args.consent,
      args.verificationToken,
    );
    if (r.ok) return r;
    // Card couldn't be attached — keep the booking, flag for the desk.
    console.error("[saveNoShowCardAction] card NOT saved (booking kept, flagged):", r.reason, "booking", args.bookingId);
    await flagNeedsCard(args.bookingId);
    return r;
  } catch (e) {
    // Log the FULL Square error (the provider throws "Square POST /cards -> …")
    // so the exact decline code is visible in Vercel runtime logs.
    console.error("[saveNoShowCardAction] threw (booking kept, flagged):", e instanceof Error ? e.message : e, "booking", args.bookingId);
    await flagNeedsCard(args.bookingId);
    return { ok: false, reason: e instanceof Error ? e.message : "card_save_failed" };
  }
}

/**
 * Reuse a returning customer's EXISTING saved card for this booking (one-tap, no
 * re-entry). OTP-gated + server-authoritative (the card is re-derived from the
 * OTP-verified phone in reuseNoShowCardForBooking). Same failure contract as
 * saveNoShowCardAction: a failure FLAGS the booking for the desk — never cancels.
 */
export async function reuseNoShowCardAction(args: {
  bookingId: string;
  otpSessionId: string;
  consent: boolean;
}): Promise<{ ok: boolean; reason: string; last4?: string }> {
  try {
    const r = await reuseNoShowCardForBooking(args.bookingId, args.otpSessionId, args.consent);
    if (r.ok) return r;
    console.error("[reuseNoShowCardAction] card NOT reused (booking kept, flagged):", r.reason, "booking", args.bookingId);
    await flagNeedsCard(args.bookingId);
    return r;
  } catch (e) {
    console.error("[reuseNoShowCardAction] threw (booking kept, flagged):", e instanceof Error ? e.message : e, "booking", args.bookingId);
    await flagNeedsCard(args.bookingId);
    return { ok: false, reason: e instanceof Error ? e.message : "card_reuse_failed" };
  }
}
