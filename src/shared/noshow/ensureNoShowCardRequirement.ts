import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Unified no-show card gate for EVERY booking-creation path.
 *
 * The online individual flow captures a card inline at confirm; every OTHER
 * path (desk individual/group, online group, walk-in, voice AI, quick-rebook,
 * Wix import) historically bypassed the card gate entirely. Call this once
 * right after the booking row exists and it flags `noshow_card_required` using
 * the SAME decision the capture component uses (`noShowCardDecision`), so the
 * requirement is consistent across all sources.
 *
 * Deliberately a FLAG only — it does NOT auto-cancel and does NOT auto-text.
 * The desk surfaces a "⚠️ needs card" badge + a one-tap "send save-card link",
 * so a human decides (auto-cancelling a salon-made or Wix-imported booking for
 * a missing card would be wrong). Idempotent + best-effort: never throws to the
 * caller, never blocks a booking.
 */
export async function ensureNoShowCardRequirement(
  bookingId: string,
): Promise<{ required: boolean; feeCents: number }> {
  try {
    const id = (bookingId ?? "").trim();
    if (!id) return { required: false, feeCents: 0 };

    const { noShowCardDecision, autoAttachReturningCard } = await import(
      "@/shared/integrations/square/noshow"
    );
    // Returning customer with a card already on file → carry it forward so this
    // booking is protected without re-asking (desk/group/walk-in/voice paths).
    // If attached, there's nothing to flag — the card is on file.
    const carried = await autoAttachReturningCard(id);
    if (carried.attached) return { required: false, feeCents: 0 };

    const decision = await noShowCardDecision(id);
    if (!decision.required) return { required: false, feeCents: 0 };

    const db = createServiceRoleClient();
    await db
      .from("bookings" as never)
      .update({
        noshow_card_required: true,
        noshow_fee_cents: decision.feeCents,
      })
      .eq("id", id);

    return { required: true, feeCents: decision.feeCents };
  } catch (e) {
    console.error("[ensureNoShowCardRequirement]", e);
    return { required: false, feeCents: 0 };
  }
}
