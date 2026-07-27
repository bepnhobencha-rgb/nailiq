import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type ExecutionHeartbeatPhase = "started" | "succeeded" | "failed";

export type ExecutionWorkerHeartbeatRow = {
  worker_name: "ai_execution";
  run_id: string | null;
  status: "unknown" | "running" | "succeeded" | "failed";
  started_at: string | null;
  completed_at: string | null;
  succeeded_at: string | null;
  last_error: string | null;
  summary: Record<string, unknown>;
  updated_at: string;
};

export async function recordExecutionWorkerHeartbeat(input: {
  runId: string;
  phase: ExecutionHeartbeatPhase;
  now: Date;
  summary?: Record<string, unknown>;
  error?: string | null;
}): Promise<void> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "record_ai_execution_worker_heartbeat" as never,
    {
      p_run_id: input.runId,
      p_phase: input.phase,
      p_now: input.now.toISOString(),
      p_summary: input.summary ?? {},
      p_error: input.error?.slice(0, 1000) ?? null,
    } as never,
  );
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error("stale_execution_heartbeat");
}

export async function getExecutionWorkerHeartbeat(): Promise<
  ExecutionWorkerHeartbeatRow | null
> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("ai_execution_worker_state" as never)
    .select(
      "worker_name, run_id, status, started_at, completed_at, succeeded_at, last_error, summary, updated_at",
    )
    .eq("worker_name" as never, "ai_execution")
    .maybeSingle();
  if (error) {
    console.error("[getExecutionWorkerHeartbeat]", error);
    return null;
  }
  return (data as ExecutionWorkerHeartbeatRow | null) ?? null;
}
