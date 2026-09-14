import "server-only";
import { z } from "zod";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { defaultSip } from "@/shared/ai/defaultSip";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

const protectionIdentity = z.object({
  bookingId: z.string().trim().uuid().transform((id) => id.toLowerCase()),
  salonId: z.string().trim().uuid().transform((id) => id.toLowerCase()),
});

/**
 * Unified no-show protection gate for ALL booking channels.
 *
 * Previously, only online bookings triggered the AI policy agent
 * (via evaluateBookingNoShow). Voice, desk, and group bookings called
 * ensureNoShowCardRequirement directly — bypassing the AI layer even when
 * ai_noshow_policy_shadow or ai_noshow_policy_live was enabled.
 *
 * This function is the single entry point regardless of channel:
 *  - When ai_noshow_policy_shadow OR ai_noshow_policy_live is on for the salon,
 *    the AI agent runs (shadow=log-only, live=AI decision drives the flag).
 *  - Otherwise falls back to the deterministic ensureNoShowCardRequirement.
 *
 * Internal helper only. Public entry points must establish their own authority
 * before calling; this must never be exported as a standalone Server Action.
 * Idempotent + best-effort: never throws to the caller, never blocks a booking.
 */
export async function handleBookingProtection(
  bookingId: string,
  salonId: string,
  channel: "online" | "voice" | "desk" | "group" | "wix" | "quick_rebook",
): Promise<void> {
  try {
    const identity = protectionIdentity.safeParse({ bookingId, salonId });
    if (!identity.success) return;
    const { bookingId: id, salonId: sid } = identity.data;
    void channel; // The booking row is the source of truth for channel context.

    const db = looseServiceClient();
    // Never combine one salon's AI flags with another salon's booking. Fail
    // closed on a missing row or read failure before either policy can write.
    const { data: booking, error: bookingError } = await db
      .from("bookings")
      .select("id, salon_id")
      .eq("id", id)
      .eq("salon_id", sid)
      .maybeSingle();
    if (bookingError || booking?.id !== id || booking?.salon_id !== sid) return;

    // Read salon to determine AI flag state and build the SIP (Salon Intelligence
    // Profile). The ai_profile column is NULL until the Manager Briefing (P1) is
    // completed; defaultSip() derives a safe fallback from existing fields.
    const { data: salonRow, error: salonError } = await db
      .from("salons")
      .select("id, ai_profile, feature_flags")
      .eq("id", sid)
      .maybeSingle();
    if (salonError || salonRow?.id !== sid) return;
    const salon = salonRow as Row;

    const flags = (salon.feature_flags as Record<string, unknown> | null) ?? {};
    const shadowOn = flags.ai_noshow_policy_shadow === true;
    const liveOn = flags.ai_noshow_policy_live === true;

    if (shadowOn || liveOn) {
      // Build SIP for logging / future policy conditioning. Not yet consumed
      // by runNoShowPolicyAgent (that reads flags itself from gatherPolicyContext);
      // passed here so the channel context is available for P1 strictness tuning.
      const sip = defaultSip({
        ai_profile: salon.ai_profile as SalonIntelligenceProfile | null,
      });

      // Desk bookings have a staff member present → slightly lower default risk
      // vs. an anonymous online booking.  The channel is forwarded into the
      // context so the agent can calibrate (gatherPolicyContext already reads
      // booking_channel from the bookings row, so the agent sees it naturally).
      void sip; // consumed in P1 when the agent accepts an explicit sip param

      // AI path: runNoShowPolicyAgent reads its own flags from gatherPolicyContext
      // (which queries the salons row again internally).  That's an extra query
      // but keeps the agent self-contained and correct in shadow mode.
      const { runNoShowPolicyAgent } = await import(
        "@/shared/noshow/agentNoShowPolicy"
      );
      // applyToRow=true so the agent writes noshow_card_required directly when
      // in LIVE mode and no surrounding update exists (same as the cron path).
      const agentDecision = await runNoShowPolicyAgent(id, {
        applyToRow: liveOn,
      });

      // Shadow mode, a rule-first skip, a durable rate-limit denial, or an AI
      // failure all fall back to the hard rule. This is essential in LIVE mode:
      // optimizing away a model call must never leave a booking unprotected.
      if (!liveOn || !agentDecision) {
        const { ensureNoShowCardRequirement } = await import(
          "@/shared/noshow/ensureNoShowCardRequirement"
        );
        await ensureNoShowCardRequirement(id);
      }
      return;
    }

    // Default path: AI not opted-in → deterministic hard rule.
    const { ensureNoShowCardRequirement } = await import(
      "@/shared/noshow/ensureNoShowCardRequirement"
    );
    await ensureNoShowCardRequirement(id);
  } catch {
    // Database/provider exceptions may contain customer data. Keep the failure
    // diagnostic stable and safe; booking creation remains committed.
    console.error("[handleBookingProtection] protection_evaluation_unavailable");
  }
}
