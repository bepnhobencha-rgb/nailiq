"use server";

import { revalidatePath } from "next/cache";

import { sealCampaignDispatchPlan } from "@/shared/ai/campaignDispatchPlan";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type SealCampaignPlanActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function sealCampaignPlanAction(input: {
  slug: string;
  jobId: string;
}): Promise<SealCampaignPlanActionResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const result = await sealCampaignDispatchPlan({
    salonId: ctx.salon.id,
    jobId: input.jobId,
  });
  if (!result.ok) return result;

  revalidatePath(`/dashboard/${input.slug}/ai`);
  return { ok: true };
}
