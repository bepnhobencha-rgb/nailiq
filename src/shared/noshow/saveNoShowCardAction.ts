"use server";

import { saveNoShowCardForBooking } from "@/shared/integrations/square/noshow";
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
}): Promise<{ ok: boolean; reason: string; last4?: string }> {
  try {
    const r = await saveNoShowCardForBooking(args.bookingId, args.sourceId, args.consent);
    if (r.ok) return r;
    // Required card failed → release the slot (anon UPDATE can't, RLS).
    await createServiceRoleClient()
      .from("bookings" as never)
      .update({ status: "cancelled" } as never)
      .eq("id", args.bookingId);
    return r;
  } catch (e) {
    await createServiceRoleClient()
      .from("bookings" as never)
      .update({ status: "cancelled" } as never)
      .eq("id", args.bookingId)
      .then(() => {}, () => {});
    return { ok: false, reason: e instanceof Error ? e.message : "card_save_failed" };
  }
}
