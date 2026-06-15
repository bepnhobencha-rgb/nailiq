"use server";

import { saveNoShowCardForBooking, reuseNoShowCardForBooking } from "@/shared/integrations/square/noshow";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Save the customer's card for a just-created booking (Option A: the card gate
 * runs INSIDE confirm, before SMS/email). On failure of a REQUIRED card, the
 * booking is cancelled server-side so a customer who can't leave a card doesn't
 * end up holding a confirmed slot — the caller then surfaces an error and no
 * confirmation is sent. Returns {ok}.
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
    // Required card failed → release the slot (anon UPDATE can't, RLS).
    console.error("[saveNoShowCardAction] card NOT saved:", r.reason, "booking", args.bookingId);
    await createServiceRoleClient()
      .from("bookings" as never)
      .update({ status: "cancelled" } as never)
      .eq("id", args.bookingId);
    return r;
  } catch (e) {
    // Log the FULL Square error (the provider throws "Square POST /cards -> …")
    // so the exact decline code is visible in Vercel runtime logs.
    console.error("[saveNoShowCardAction] threw:", e instanceof Error ? e.message : e, "booking", args.bookingId);
    await createServiceRoleClient()
      .from("bookings" as never)
      .update({ status: "cancelled" } as never)
      .eq("id", args.bookingId)
      .then(() => {}, () => {});
    return { ok: false, reason: e instanceof Error ? e.message : "card_save_failed" };
  }
}

/**
 * Reuse a returning customer's EXISTING saved card for this booking (one-tap, no
 * re-entry). OTP-gated + server-authoritative (the card is re-derived from the
 * OTP-verified phone in reuseNoShowCardForBooking). Same failure contract as
 * saveNoShowCardAction: a required card that can't be attached cancels the slot.
 */
export async function reuseNoShowCardAction(args: {
  bookingId: string;
  otpSessionId: string;
  consent: boolean;
}): Promise<{ ok: boolean; reason: string; last4?: string }> {
  try {
    const r = await reuseNoShowCardForBooking(args.bookingId, args.otpSessionId, args.consent);
    if (r.ok) return r;
    console.error("[reuseNoShowCardAction] card NOT reused:", r.reason, "booking", args.bookingId);
    await createServiceRoleClient()
      .from("bookings" as never)
      .update({ status: "cancelled" } as never)
      .eq("id", args.bookingId);
    return r;
  } catch (e) {
    console.error("[reuseNoShowCardAction] threw:", e instanceof Error ? e.message : e, "booking", args.bookingId);
    await createServiceRoleClient()
      .from("bookings" as never)
      .update({ status: "cancelled" } as never)
      .eq("id", args.bookingId)
      .then(() => {}, () => {});
    return { ok: false, reason: e instanceof Error ? e.message : "card_reuse_failed" };
  }
}
