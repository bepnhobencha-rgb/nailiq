"use server";

import { revalidatePath } from "next/cache";

import { reviewReplyLanguage, safeReviewReplyDraft } from "@/shared/ai/reviewReplyPolicy";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type UpdateReviewReplyDraftResult =
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

export async function updateReviewReplyDraftAction(input: {
  slug: string;
  approvalId: string;
  draftReply: string;
}): Promise<UpdateReviewReplyDraftResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role) || !ctx.userId) {
    return { ok: false, error: "forbidden" };
  }

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
  if (approval.action_type !== "review_reply_draft") {
    return { ok: false, error: "not_found" };
  }
  if (approval.status !== "pending") {
    return { ok: false, error: "already_decided" };
  }

  const payload = approval.payload ?? {};
  const language = reviewReplyLanguage(payload.language, "");
  const safeDraft = safeReviewReplyDraft(input.draftReply, language);
  if (!safeDraft) return { ok: false, error: "invalid_draft" };

  const { data, error } = await db.rpc(
    "update_review_reply_draft_as_actor" as never,
    {
      p_approval_id: input.approvalId,
      p_actor_user_id: ctx.userId,
      p_draft_reply: safeDraft,
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
  if (outcome !== "updated") return { ok: false, error: "server_error" };

  revalidatePath(`/dashboard/${input.slug}/ai`);
  revalidatePath(`/dashboard/${input.slug}/approvals`);
  return { ok: true };
}
