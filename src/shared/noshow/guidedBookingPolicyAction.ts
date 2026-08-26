"use server";

import { attributeRecentAudit } from "@/shared/dashboard/attributeAudit";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

type GuidedBookingPolicyInput = {
  en: string;
  vi: string;
  groupTogetherThresholdMinutes?: number;
  noShowGroupWholeParty?: boolean;
};

export async function saveGuidedBookingPolicy(
  slug: string,
  input: GuidedBookingPolicyInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) {
    return { ok: false, error: "unauthorized" };
  }

  const en = typeof input.en === "string" ? input.en.trim().slice(0, 8000) : "";
  const vi = typeof input.vi === "string" ? input.vi.trim().slice(0, 8000) : "";
  if (!en || !vi) return { ok: false, error: "policy_languages_required" };

  const hasGroupThreshold = input.groupTogetherThresholdMinutes !== undefined;
  const hasWholePartyRule = input.noShowGroupWholeParty !== undefined;
  if (hasGroupThreshold !== hasWholePartyRule) {
    return { ok: false, error: "group_policy_incomplete" };
  }

  const patch: Record<string, unknown> = {
    cancellation_policy: { en, vi },
  };
  if (hasGroupThreshold && hasWholePartyRule) {
    const threshold = Number(input.groupTogetherThresholdMinutes);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 120) {
      return { ok: false, error: "invalid_group_together_window" };
    }
    if (typeof input.noShowGroupWholeParty !== "boolean") {
      return { ok: false, error: "invalid_group_no_show_rule" };
    }
    patch.group_together_threshold_minutes = threshold;
    patch.noshow_group_whole_party = input.noShowGroupWholeParty;
  }

  const { data, error } = await ctx.supabase
    .from("salons")
    .update(patch as never)
    .eq("id", ctx.salon.id)
    .eq("slug", slug)
    .select("id")
    .maybeSingle();

  if (error || !data) return { ok: false, error: "server_error" };

  await attributeRecentAudit(ctx.salon.id, ["salons"], ctx.userId);
  return { ok: true };
}
