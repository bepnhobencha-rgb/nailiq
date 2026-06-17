"use server";

import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type SavedNoShowCard =
  | { hasSavedCard: false }
  | { hasSavedCard: true; brand: string; last4: string };

/**
 * For a returning, OTP-VERIFIED customer, report whether they already have a
 * card on file at this salon so the confirm step can offer "use your saved
 * card" (one tap) instead of re-typing it.
 *
 * SECURITY — this is the gate that prevents "type any phone number, see whether
 * it has a card + its last4". We REQUIRE a valid OTP session id and take the
 * phone FROM that session (never from the client). A session is only created
 * after Twilio Verify succeeds (`/api/booking-otp/verify`), is salon-scoped,
 * 15-min TTL, single-use. We return display fields only (brand + last4) — never
 * the card id (the actual reuse is re-derived server-side at booking time).
 */
export async function resolveSavedNoShowCard(args: {
  salonId: string;
  otpSessionId: string;
}): Promise<SavedNoShowCard> {
  try {
    if (!args.otpSessionId) return { hasSavedCard: false };

    // Validate the OTP session with the service role (RLS-independent) and read
    // the verified phone from it.
    const sb = createServiceRoleClient();
    const { data: sessRow } = await sb
      .from("phone_otp_sessions" as never)
      .select("phone, salon_id, expires_at, consumed_at")
      .eq("id", args.otpSessionId)
      .maybeSingle();
    const sess = sessRow as
      | { phone: string; salon_id: string; expires_at: string; consumed_at: string | null }
      | null;
    if (!sess) return { hasSavedCard: false };
    if (sess.salon_id !== args.salonId) return { hasSavedCard: false };
    if (sess.consumed_at) return { hasSavedCard: false };
    if (Date.parse(sess.expires_at) < Date.now()) return { hasSavedCard: false };

    const phone = (sess.phone || "").replace(/\D/g, "");
    if (phone.length < 8) return { hasSavedCard: false };

    // Provider-agnostic (Square + Stripe). The phone came from the OTP session.
    const provider = await resolvePaymentProvider(args.salonId);
    if (!provider) return { hasSavedCard: false };

    const card = await provider.findSavedCardByPhone(phone);
    if (!card || !card.last4) return { hasSavedCard: false };

    return { hasSavedCard: true, brand: card.brand, last4: card.last4 };
  } catch (e) {
    console.error("[resolveSavedNoShowCard]", e);
    return { hasSavedCard: false }; // fail-safe: just offer new-card entry
  }
}
