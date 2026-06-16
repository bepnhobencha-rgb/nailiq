"use server";

import { revalidatePath } from "next/cache";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isFrontDeskRole } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Desk override of the AI no-show policy agent.
 *
 * When the agent runs in LIVE mode it sets the "needs a card on file" flag per
 * booking. A human at the desk can disagree and flip it: require a card the AI
 * waived, or waive one the AI required. The override:
 *  - updates the booking's `noshow_card_required` flag (the only thing the agent
 *    controls — charging stays manual + consent-gated, so this never moves money),
 *  - logs an `ai_policy_decisions` row with mode 'override' + applied=true,
 *    stamped with WHO did it, so the Activity feed shows "AI suggested X → {name}
 *    changed it to Y" and every override is attributable.
 *
 * Front-desk roles only (same gate as the save-card-link action).
 */
export type OverrideNoShowPolicyResult =
  | { ok: false; error: "unauthorized" | "forbidden" | "invalid_booking" | "server_error" }
  | { ok: true; cardRequired: boolean };

export async function overrideNoShowPolicy(
  slug: string,
  input: { bookingId: string; decision: "card" | "none" },
): Promise<OverrideNoShowPolicyResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isFrontDeskRole(ctx.role)) return { ok: false, error: "forbidden" };

  const bookingId = String(input.bookingId ?? "").trim();
  const decision = input.decision === "card" ? "card" : "none";
  if (!bookingId) return { ok: false, error: "invalid_booking" };

  // Booking must be in the caller's salon (RLS client). Read the current flag so
  // the log records what the AI/rule had before this human override.
  const { data: bk } = await ctx.supabase
    .from("bookings")
    .select("id, noshow_card_required")
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id)
    .maybeSingle();
  if (!bk?.id) return { ok: false, error: "invalid_booking" };

  const cardRequired = decision === "card";
  const priorRequired =
    (bk as { noshow_card_required?: boolean | null }).noshow_card_required === true;

  try {
    await ctx.supabase
      .from("bookings")
      .update({ noshow_card_required: cardRequired })
      .eq("id", bookingId)
      .eq("salon_id", ctx.salon.id);

    // Service-role insert — ai_policy_decisions is RLS service-only.
    const svc = createServiceRoleClient();
    await svc.from("ai_policy_decisions" as never).insert({
      salon_id: ctx.salon.id,
      booking_id: bookingId,
      agent: "noshow_policy",
      mode: "override",
      ai_protection: decision,
      ai_fee_percent: null,
      ai_reason: cardRequired
        ? "Nhân viên yêu cầu lưu thẻ (override quyết định AI)"
        : "Nhân viên bỏ yêu cầu thẻ (override quyết định AI)",
      ai_message: null,
      ai_confidence: null,
      rule_protection: priorRequired ? "card" : "none",
      applied: true,
      actor_user_id: ctx.userId ?? null,
    } as never);
  } catch (e) {
    console.error("[overrideNoShowPolicy]", e);
    return { ok: false, error: "server_error" };
  }

  revalidatePath(`/dashboard/${slug}/center`);
  return { ok: true, cardRequired };
}
