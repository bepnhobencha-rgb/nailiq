"use server";

import { revalidatePath } from "next/cache";

import { prepareExecutionAudience } from "@/shared/ai/audiencePreparation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";

export type PrepareAudienceActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function prepareAudienceAction(input: {
  slug: string;
  jobId: string;
}): Promise<PrepareAudienceActionResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const result = await prepareExecutionAudience({
    salonId: ctx.salon.id,
    jobId: input.jobId,
  });
  if (!result.ok) return result;

  revalidatePath(`/dashboard/${input.slug}/ai`);
  return { ok: true };
}
