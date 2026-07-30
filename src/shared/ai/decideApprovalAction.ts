"use server";

import { revalidatePath } from "next/cache";

import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type DecideApprovalActionResult =
  | { ok: true; status: "approved" | "declined" }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "not_found"
        | "expired"
        | "already_decided"
        | "server_error";
    };

export async function decideApprovalAction(input: {
  slug: string;
  approvalId: string;
  decision: "approved" | "declined";
}): Promise<DecideApprovalActionResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role) || !ctx.userId) {
    return { ok: false, error: "forbidden" };
  }

  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "decide_ai_approval_request_as_actor" as never,
    {
      p_approval_id: input.approvalId,
      p_decision: input.decision,
      p_actor_user_id: ctx.userId,
    } as never,
  );

  if (error) {
    console.error("[decideApprovalAction]", error);
    return { ok: false, error: "server_error" };
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    outcome?: unknown;
  } | null;
  if (row?.outcome === "not_found") return { ok: false, error: "not_found" };
  if (row?.outcome === "forbidden") return { ok: false, error: "forbidden" };
  if (row?.outcome === "expired") return { ok: false, error: "expired" };
  if (row?.outcome === "already_decided") {
    return { ok: false, error: "already_decided" };
  }
  if (
    row?.outcome !== "approved_queued" &&
    row?.outcome !== "declined"
  ) {
    return { ok: false, error: "server_error" };
  }

  revalidatePath(`/dashboard/${input.slug}/ai`);
  revalidatePath(`/dashboard/${input.slug}/approvals`);
  return { ok: true, status: input.decision };
}
