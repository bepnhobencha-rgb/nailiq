"use server";

import { redirect } from "next/navigation";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isCocoSetupExperienceVisible } from "@/shared/dashboard/cocoSetupActivation";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export async function skipGuidedSetupIntegrations(slug: string): Promise<void> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !isOwnerOrAdmin(ctx.role)) redirect("/register");
  if (!(await isCocoSetupExperienceVisible(ctx.salon))) {
    redirect(`/dashboard/${encodeURIComponent(slug)}`);
  }

  const { error } = await createServiceRoleClient()
    .from("salons")
    .update({
      guided_setup_integrations_skipped_at: new Date().toISOString(),
    } as never)
    .eq("id", ctx.salon.id);
  if (error) {
    console.error("[skipGuidedSetupIntegrations]", { code: error.code });
    redirect(`/dashboard/${encodeURIComponent(slug)}/setup?skip=failed`);
  }
  redirect(`/dashboard/${encodeURIComponent(slug)}/setup/preview`);
}
