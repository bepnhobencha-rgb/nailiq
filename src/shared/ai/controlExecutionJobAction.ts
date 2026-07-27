"use server";

import { revalidatePath } from "next/cache";

import type { ExecutionJobControl } from "@/shared/ai/executionPolicy";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type ControlExecutionJobActionResult =
  | { ok: true; status: "queued" | "canceled" }
  | {
      ok: false;
      error: "unauthorized" | "forbidden" | "not_found" | "invalid_state" | "server_error";
    };

export async function controlExecutionJobAction(input: {
  slug: string;
  jobId: string;
  operation: ExecutionJobControl;
}): Promise<ControlExecutionJobActionResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "control_ai_execution_job" as never,
    {
      p_salon_id: ctx.salon.id,
      p_job_id: input.jobId,
      p_operation: input.operation,
      p_actor_user_id: ctx.userId,
    } as never,
  );

  if (error) {
    console.error("[controlExecutionJobAction]", error);
    return { ok: false, error: "server_error" };
  }

  const row = (
    Array.isArray(data) ? data[0] : data
  ) as { outcome?: unknown; job_status?: unknown } | null;
  if (row?.outcome === "not_found") return { ok: false, error: "not_found" };
  if (row?.outcome === "invalid_state") {
    return { ok: false, error: "invalid_state" };
  }
  if (
    row?.outcome !== "updated" ||
    (row.job_status !== "queued" && row.job_status !== "canceled")
  ) {
    return { ok: false, error: "server_error" };
  }

  revalidatePath(`/dashboard/${input.slug}/ai`);
  return { ok: true, status: row.job_status };
}
