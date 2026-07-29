import "server-only";

import type { ExecutionJobStatus } from "@/shared/ai/executionPolicy";
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

export async function getExecutionJobs(
  salonId: string,
  limit = 50,
): Promise<ExecutionJobRow[]> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("ai_execution_jobs" as never)
    .select("*")
    .eq("salon_id" as never, salonId)
    .order("created_at" as never, { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));
  if (error) {
    throw new Error("ai_execution_jobs_read_failed", { cause: error });
  }
  return (data as ExecutionJobRow[] | null) ?? [];
}
