import "server-only";

import type { ExecutionJobStatus } from "@/shared/ai/executionPolicy";
import {
  toOwnerExecutionBlocker,
  toOwnerExecutionJob,
  type OwnerExecutionBlocker,
  type OwnerExecutionJob,
  type OwnerExecutionJobSource,
} from "@/shared/ai/executionOwnerView";
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
  lease_token: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type ApprovalExecutionTraceRow = {
  approval_request_id: string;
  status: ExecutionJobStatus;
  attempt_count: number;
  max_attempts: number;
  blocker: OwnerExecutionBlocker | null;
  created_at: string;
  updated_at: string;
};

/**
 * Loads only the execution fields needed by owner-facing surfaces.
 *
 * Internal payloads, tenant IDs, idempotency keys, lease credentials and
 * timestamps never leave this server module. Result objects and errors are
 * additionally allowlisted before the values can be serialized to a client.
 */
export async function getOwnerExecutionJobs(
  salonId: string,
  limit = 50,
): Promise<OwnerExecutionJob[]> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("ai_execution_jobs" as never)
    .select(
      "id,approval_request_id,action_type,status,attempt_count,max_attempts,last_error,result,created_at",
    )
    .eq("salon_id" as never, salonId)
    .order("created_at" as never, { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));
  if (error) {
    throw new Error("ai_execution_jobs_read_failed", { cause: error });
  }
  return ((data as OwnerExecutionJobSource[] | null) ?? []).map(
    toOwnerExecutionJob,
  );
}

/**
 * Loads only the execution facts needed to explain recent approval decisions.
 *
 * The tenant filter and bounded approval IDs are both mandatory. Raw payloads,
 * idempotency keys, lease tokens, results, and internal job IDs never cross the
 * server/client boundary through this view model.
 */
export async function getApprovalExecutionTraces(
  salonId: string,
  approvalIds: string[],
): Promise<ApprovalExecutionTraceRow[]> {
  const ids = [...new Set(approvalIds.filter(Boolean))].slice(0, 20);
  if (ids.length === 0) return [];

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("ai_execution_jobs" as never)
    .select(
      "approval_request_id,status,attempt_count,max_attempts,payload,created_at,updated_at",
    )
    .eq("salon_id" as never, salonId)
    .in("approval_request_id" as never, ids)
    .order("created_at" as never, { ascending: false });
  if (error) {
    throw new Error("ai_approval_execution_traces_read_failed", {
      cause: error,
    });
  }

  return (
    (data as
      | Array<{
          approval_request_id: string;
          status: ExecutionJobStatus;
          attempt_count: number;
          max_attempts: number;
          payload: Record<string, unknown> | null;
          created_at: string;
          updated_at: string;
        }>
      | null) ?? []
  ).map(({ payload, ...row }) => ({
    ...row,
    blocker: toOwnerExecutionBlocker(payload?.blocker),
  }));
}
