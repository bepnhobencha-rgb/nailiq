"use server";

import { revalidatePath } from "next/cache";

import { preflightCampaignDispatch } from "@/shared/ai/campaignDispatchPreflight";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type PreflightCampaignActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function preflightCampaignAction(input: {
  slug: string;
  jobId: string;
}): Promise<PreflightCampaignActionResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const result = await preflightCampaignDispatch({
    salonId: ctx.salon.id,
    jobId: input.jobId,
  });
  if (!result.ok) return result;

  revalidatePath(`/dashboard/${input.slug}/ai`);
  return { ok: true };
}
