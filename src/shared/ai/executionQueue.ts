import "server-only";

import type { ApprovalRow } from "@/shared/ai/approvalRequests";
import {
  initialExecutionStatus,
  type ExecutionJobStatus,
} from "@/shared/ai/executionPolicy";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type ExecutionJobRow = {
  id: string;
  salon_id: string;
  approval_request_id: string;
  action_type: string;
  payload: Record<string, unknown>;
  status: ExecutionJobStatus;
  idempotency_key: string;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export async function enqueueApprovedAction(
  approval: ApprovalRow,
): Promise<{ ok: true; job: ExecutionJobRow } | { ok: false; error: string }> {
  if (approval.status !== "approved") {
    return { ok: false, error: "approval_not_approved" };
  }

  const db = createServiceRoleClient();
  const status = initialExecutionStatus(approval.payload);
  const now = new Date().toISOString();
  const idempotencyKey = `approval:${approval.id}`;

  const { data, error } = await db
    .from("ai_execution_jobs" as never)
    .upsert(
      {
        salon_id: approval.salon_id,
        approval_request_id: approval.id,
        action_type: approval.action_type,
        payload: approval.payload,
        status,
        idempotency_key: idempotencyKey,
        result:
          status === "waiting_input"
            ? { blocker: "recipient_selection_required" }
            : null,
        updated_at: now,
      } as never,
      { onConflict: "approval_request_id", ignoreDuplicates: true },
    )
    .select("*")
    .maybeSingle();

  if (error) {
    console.error("[enqueueApprovedAction]", error);
    return { ok: false, error: error.message };
  }

  if (data) return { ok: true, job: data as ExecutionJobRow };

  const { data: existing, error: existingError } = await db
    .from("ai_execution_jobs" as never)
    .select("*")
    .eq("approval_request_id" as never, approval.id)
    .maybeSingle();

  if (existingError || !existing) {
    return {
      ok: false,
      error: existingError?.message ?? "execution_job_not_found",
    };
  }
  return { ok: true, job: existing as ExecutionJobRow };
}

export async function getExecutionJobs(
  salonId: string,
  limit = 50,
): Promise<ExecutionJobRow[]> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("ai_execution_jobs" as never)
    .select("*")
    .eq("salon_id" as never, salonId)
    .order("created_at" as never, { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));
  return (data as ExecutionJobRow[] | null) ?? [];
}
