import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { v1AllowsCustomerPaymentGateway } from "@/shared/release/v1IntegrationScope";

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
  options?: { strict?: boolean },
): Promise<{ required: boolean; feeCents: number }> {
  // V1 keeps payment methods entirely provider-owned. This is a definitive
  // product state, not an outage: do not probe a provider, flag the booking, or
  // manufacture a card-pending recovery item while the gateway is hard off.
  if (!v1AllowsCustomerPaymentGateway()) {
    return { required: false, feeCents: 0 };
  }

  try {
    const id = (bookingId ?? "").trim();
    if (!id) {
      if (options?.strict) throw new Error("invalid_booking_id");
      return { required: false, feeCents: 0 };
    }

    // The legacy decision helper predates fail-closed public capability
    // exchange and treats some read failures like an empty dataset. Strict
    // callers first prove the authoritative tenant/policy/history inputs are
    // readable so an outage cannot silently become "card not required".
    if (options?.strict) {
      const probe = createServiceRoleClient();
      const bookingProbe = await probe
        .from("bookings" as never)
        .select("salon_id,client_phone,group_id" as never)
        .eq("id" as never, id)
        .maybeSingle();
      if (bookingProbe.error || !bookingProbe.data) throw new Error("card_policy_booking_unavailable");
      const booking = bookingProbe.data as { salon_id?: string; client_phone?: string | null; group_id?: string | null };
      const salonId = String(booking.salon_id ?? "");
      if (!salonId) throw new Error("card_policy_booking_unavailable");
      const [salonProbe, providerProbe, historyProbe, groupProbe] = await Promise.all([
        probe.from("salons" as never)
          .select("noshow_protection_enabled,noshow_fee_percent,noshow_risk_threshold,noshow_group_whole_party,noshow_deposit_escalation_threshold,noshow_require_new_customer,noshow_require_prior_noshow,noshow_min_noshow_count,noshow_require_high_risk,payment_provider,currency_code,cancellation_policy" as never)
          .eq("id" as never, salonId).maybeSingle(),
        probe.from("square_integrations" as never)
          .select("enabled,deposit_enabled" as never).eq("salon_id" as never, salonId).maybeSingle(),
        probe.from("bookings" as never)
          .select("id,status" as never).eq("salon_id" as never, salonId)
          .eq("client_phone" as never, String(booking.client_phone ?? "")).limit(1),
        booking.group_id
          ? probe.from("bookings" as never).select("id,price_cents,status" as never)
            .eq("salon_id" as never, salonId)
            .eq("group_id" as never, booking.group_id).limit(20)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (salonProbe.error || !salonProbe.data || providerProbe.error || historyProbe.error || groupProbe.error) {
        throw new Error("card_policy_inputs_unavailable");
      }
    }

    const { noShowCardDecision, autoAttachReturningCard } = await import(
      "@/shared/integrations/square/noshow"
    );
    // Returning customer with a card already on file → carry it forward so this
    // booking is protected without re-asking (desk/group/walk-in/voice paths).
    // If attached, there's nothing to flag — the card is on file.
    const carried = await autoAttachReturningCard(id);
    if (options?.strict && carried.reason === "error") throw new Error("card_policy_unavailable");
    if (carried.attached) return { required: false, feeCents: 0 };

    const decision = await noShowCardDecision(id, { strict: options?.strict === true });
    if (!decision.required) return { required: false, feeCents: 0 };

    const db = createServiceRoleClient();
    const updated = await db
      .from("bookings" as never)
      .update({
        noshow_card_required: true,
        noshow_fee_cents: decision.feeCents,
      })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (options?.strict && (updated.error || !updated.data)) {
      throw new Error("card_requirement_write_failed");
    }

    return { required: true, feeCents: decision.feeCents };
  } catch (e) {
    console.error("[ensureNoShowCardRequirement]", e);
    if (options?.strict) throw e;
    return { required: false, feeCents: 0 };
  }
}
