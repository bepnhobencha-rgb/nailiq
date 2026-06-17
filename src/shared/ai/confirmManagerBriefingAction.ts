"use server";

// Confirms the Manager Briefing: writes the approved SIP to salons.ai_profile.

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

export type ConfirmResult = { ok: true } | { ok: false; error: string };

export async function confirmManagerBriefing(input: {
  slug: string;
  sip: SalonIntelligenceProfile;
}): Promise<ConfirmResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  // Stamp the confirmation time
  const sip: SalonIntelligenceProfile = {
    ...input.sip,
    built_at: new Date().toISOString(),
    built_via: "manager_briefing",
  };

  const { error } = await ctx.supabase
    .from("salons")
    .update({ ai_profile: sip as never })
    .eq("id", ctx.salon.id);

  if (error) {
    console.error("[confirmManagerBriefing] supabase error", error);
    return { ok: false, error: "db_error" };
  }

  return { ok: true };
}
