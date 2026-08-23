"use server";

import { revalidatePath } from "next/cache";

import { safeReactivationCampaignMessage } from "@/shared/ai/reactivationCampaignPolicy";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type UpdateReactivationCampaignDraftResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "not_found"
        | "invalid_draft"
        | "expired"
        | "already_decided"
        | "server_error";
    };

export async function updateReactivationCampaignDraftAction(input: {
  slug: string;
  approvalId: string;
  messageEn: string;
  messageVi: string;
}): Promise<UpdateReactivationCampaignDraftResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role) || !ctx.userId) {
    return { ok: false, error: "forbidden" };
  }

  const messageEn = safeReactivationCampaignMessage(input.messageEn);
  const messageVi = safeReactivationCampaignMessage(input.messageVi);
  if (!messageEn || !messageVi) return { ok: false, error: "invalid_draft" };

  const db = createServiceRoleClient();
  const { data: row, error: readError } = await db
    .from("approval_requests" as never)
    .select("salon_id,action_type,status,payload" as never)
    .eq("id" as never, input.approvalId)
    .eq("salon_id" as never, ctx.salon.id)
    .maybeSingle();
  if (readError) return { ok: false, error: "server_error" };
  if (!row) return { ok: false, error: "not_found" };

  const approval = row as unknown as {
    action_type: unknown;
    status: unknown;
    payload: Record<string, unknown> | null;
  };
  if (
    approval.action_type !== "bulk_message" ||
    approval.payload?.proposal_source !== "reactivation_campaign" ||
    approval.payload?.campaign_mode !== "dashboard_draft_only"
  ) return { ok: false, error: "not_found" };
  if (approval.status !== "pending") {
    return { ok: false, error: "already_decided" };
  }

  const { data, error } = await db.rpc(
    "update_reactivation_campaign_draft_as_actor" as never,
    {
      p_approval_id: input.approvalId,
      p_actor_user_id: ctx.userId,
      p_message_en: messageEn,
      p_message_vi: messageVi,
    } as never,
  );
  if (error) return { ok: false, error: "server_error" };
  const outcome = typeof data === "string" ? data : String(data ?? "");
  if (outcome === "forbidden") return { ok: false, error: "forbidden" };
  if (outcome === "not_found") return { ok: false, error: "not_found" };
  if (outcome === "expired") return { ok: false, error: "expired" };
  if (outcome === "already_decided") {
    return { ok: false, error: "already_decided" };
  }
  if (outcome === "invalid_draft") {
    return { ok: false, error: "invalid_draft" };
  }
  if (outcome !== "updated") return { ok: false, error: "server_error" };

  revalidatePath(`/dashboard/${input.slug}/ai`);
  revalidatePath(`/dashboard/${input.slug}/approvals`);
  return { ok: true };
}
