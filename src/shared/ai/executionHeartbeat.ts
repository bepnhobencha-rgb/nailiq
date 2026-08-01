import "server-only";

import { toSafeWorkerFailureCode } from "@/shared/ai/executionFailure";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type ExecutionHeartbeatPhase = "started" | "succeeded" | "failed";
export type CronWorkerName =
  | "ai_execution"
  | "ai_manager"
  | "campaign_scheduler"
  | "close_stale_in_progress"
  | "error_triage"
  | "minh_learn"
  | "nail_tryon_cleanup"
  | "noshow_card_nudge"
  | "noshow_charge_retry"
  | "reminders"
  | "send_pending_notifications"
  | "spend_sync"
  | "square_email_consent"
  | "square_sync"
  | "waitlist_advance"
  | "wix_sync";
export type AiWorkerName = Extract<
  CronWorkerName,
  "ai_execution" | "ai_manager"
>;

export type ExecutionWorkerHeartbeatRow = {
  worker_name: AiWorkerName;
  run_id: string | null;
  status: "unknown" | "running" | "succeeded" | "failed";
  started_at: string | null;
  completed_at: string | null;
  succeeded_at: string | null;
  last_error: string | null;
  summary: Record<string, unknown>;
  updated_at: string;
};

export type AiWorkerRunRow = {
  run_id: string;
  worker_name: AiWorkerName;
  status: "running" | "succeeded" | "failed";
  started_at: string;
  completed_at: string | null;
  error_code: string | null;
};

export async function recordExecutionWorkerHeartbeat(input: {
  runId: string;
  phase: ExecutionHeartbeatPhase;
  now: Date;
  summary?: Record<string, unknown>;
  error?: string | null;
}): Promise<void> {
  return recordAiWorkerHeartbeat({ workerName: "ai_execution", ...input });
}

export async function recordAiWorkerHeartbeat(input: {
  workerName: CronWorkerName;
  runId: string;
  phase: ExecutionHeartbeatPhase;
  now: Date;
  summary?: Record<string, unknown>;
  error?: string | null;
}): Promise<void> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "record_ai_worker_heartbeat" as never,
    {
      p_worker_name: input.workerName,
      p_run_id: input.runId,
      p_phase: input.phase,
      p_now: input.now.toISOString(),
      p_summary: input.summary ?? {},
      p_error: toSafeWorkerFailureCode(input.error),
    } as never,
  );
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error("stale_execution_heartbeat");
}

export async function getExecutionWorkerHeartbeat(): Promise<
  ExecutionWorkerHeartbeatRow | null
> {
  const rows = await getAiWorkerHeartbeats();
  return rows.find((row) => row.worker_name === "ai_execution") ?? null;
}

export async function getAiWorkerHeartbeats(
  options: { throwOnError?: boolean } = {},
): Promise<ExecutionWorkerHeartbeatRow[]> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("ai_execution_worker_state" as never)
    .select(
      "worker_name, run_id, status, started_at, completed_at, succeeded_at, last_error, summary, updated_at",
    )
    .in("worker_name" as never, ["ai_execution", "ai_manager"]);
  if (error) {
    if (options.throwOnError) {
      throw new Error("ai_worker_heartbeats_read_failed", { cause: error });
    }
    console.error("[getAiWorkerHeartbeats]", error);
    return [];
  }
  return (data as ExecutionWorkerHeartbeatRow[] | null) ?? [];
}

export async function getAiWorkerRuns(
  startedSince: Date,
  options: { throwOnError?: boolean } = {},
): Promise<AiWorkerRunRow[]> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("ai_worker_runs" as never)
    .select(
      "run_id, worker_name, status, started_at, completed_at, error_code",
    )
    .in("worker_name" as never, ["ai_execution", "ai_manager"])
    .gte("started_at" as never, startedSince.toISOString())
    .order("started_at" as never, { ascending: false })
    .limit(500);
  if (error) {
    if (options.throwOnError) {
      throw new Error("ai_worker_runs_read_failed", { cause: error });
    }
    console.error("[getAiWorkerRuns]", error);
    return [];
  }
  return (data as AiWorkerRunRow[] | null) ?? [];
}
