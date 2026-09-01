"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isCocoSetupExperienceVisible } from "@/shared/dashboard/cocoSetupActivation";
import type { CocoSetupDecisionState } from "@/shared/dashboard/cocoSetupCoverage";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import type { SetupCapabilityId } from "@/shared/dashboard/setupCoverageManifest";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const DECISION_CAPABILITIES = new Set<SetupCapabilityId>([
  "resource_capacity",
  "multi_service",
  "group_booking",
  "waitlist_walkin",
  "customer_identity_otp",
  "payments_checkout",
  "ai_automation",
  "reporting_alerts",
]);

type SaveDecisionRpcResult = {
  success?: unknown;
  code?: unknown;
};

export async function saveCocoSetupDecision(
  slug: string,
  capability: SetupCapabilityId,
  decision: CocoSetupDecisionState,
): Promise<void> {
  const setupPath = `/dashboard/${encodeURIComponent(slug)}/setup`;
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || !ctx.userId || !isOwnerOrAdmin(ctx.role)) redirect("/register");

  if (
    !DECISION_CAPABILITIES.has(capability) ||
    (decision !== "configured_off" && decision !== "not_using") ||
    !(await isCocoSetupExperienceVisible(ctx.salon))
  ) {
    redirect(`${setupPath}?coco_decision_error=invalid`);
  }

  const { data, error } = (await createServiceRoleClient().rpc(
    "save_coco_setup_decision" as never,
    {
      p_salon_id: ctx.salon.id,
      p_actor_user_id: ctx.userId,
      p_capability: capability,
      p_decision: decision,
    } as never,
  )) as { data: unknown; error: { code?: string } | null };
  const result = data as SaveDecisionRpcResult | null;

  if (error || result?.success !== true) {
    console.error("[saveCocoSetupDecision]", {
      salonId: ctx.salon.id,
      capability,
      code: error?.code ?? result?.code ?? "unknown",
    });
    redirect(`${setupPath}?coco_decision_error=save`);
  }

  revalidatePath(setupPath);
  revalidatePath(`/dashboard/${encodeURIComponent(slug)}`);
  redirect(setupPath);
}
