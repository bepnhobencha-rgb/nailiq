import "server-only";

import { planExecutionEffect } from "@/shared/ai/executionEffects";
import { nextRetryAt, type ExecutionJobStatus } from "@/shared/ai/executionPolicy";
import type { ExecutionJobRow } from "@/shared/ai/executionQueue";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type WorkerOutcome = {
  jobId: string;
  status: ExecutionJobStatus;
  attempted: boolean;
  error?: string;
};

export type ExecutionWorkerSummary = {
  inspected: number;
  recovered: number;
  claimed: number;
  succeeded: number;
  failed: number;
  waitingInput: number;
  canceled: number;
  outcomes: WorkerOutcome[];
};

class StaleExecutionLeaseError extends Error {
  constructor() {
    super("stale_execution_lease");
    this.name = "StaleExecutionLeaseError";
  }
}

async function recoverStaleRunningJobs(now: Date): Promise<number> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "recover_stale_ai_execution_jobs" as never,
    { p_now: now.toISOString() } as never,
  );
  if (error) throw new Error(error.message);
  return typeof data === "number" ? data : 0;
}

async function finishJob(
  job: ExecutionJobRow,
  input: {
    status: "waiting_input" | "succeeded" | "failed" | "canceled";
    result: Record<string, unknown> | null;
    lastError: string | null;
    availableAt: string | null;
    finishedAt: string | null;
    now: string;
    details: Record<string, unknown>;
  },
) {
  if (!job.lease_token) throw new StaleExecutionLeaseError();
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "finish_ai_execution_job" as never,
    {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_status: input.status,
      p_result: input.result,
      p_last_error: input.lastError,
      p_available_at: input.availableAt,
      p_finished_at: input.finishedAt,
      p_now: input.now,
      p_details: input.details,
    } as never,
  );
  if (error) throw new Error(error.message);
  if (data !== true) throw new StaleExecutionLeaseError();
}

async function executeClaimedJob(
  job: ExecutionJobRow,
  now: Date,
): Promise<WorkerOutcome> {
  const effect = planExecutionEffect(job);
  const nowIso = now.toISOString();

  if (effect.kind === "waiting_input") {
    await finishJob(job, {
      status: "waiting_input",
      result: { blocker: effect.blocker },
      lastError: null,
      availableAt: null,
      finishedAt: null,
      now: nowIso,
      details: { blocker: effect.blocker },
    });
    return { jobId: job.id, status: "waiting_input", attempted: true };
  }

  if (effect.kind === "unsupported") {
    await finishJob(job, {
      status: "canceled",
      result: { reason: effect.reason },
      lastError: effect.reason,
      availableAt: null,
      finishedAt: nowIso,
      now: nowIso,
      details: { reason: effect.reason },
    });
    return {
      jobId: job.id,
      status: "canceled",
      attempted: true,
      error: effect.reason,
    };
  }

  await finishJob(job, {
    status: "succeeded",
    result: {
      effect: effect.kind,
      audit_action_type: effect.actionType,
      ...effect.payload,
    },
    lastError: null,
    availableAt: null,
    finishedAt: nowIso,
    now: nowIso,
    details: {
      effect: effect.kind,
      audit_action_type: effect.actionType,
      ...effect.payload,
    },
  });
  return { jobId: job.id, status: "succeeded", attempted: true };
}

async function claimJobs(
  limit: number,
  now: Date,
): Promise<ExecutionJobRow[]> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .rpc(
      "claim_ai_execution_jobs" as never,
      { p_limit: limit, p_now: now.toISOString() } as never,
    );
  if (error) throw new Error(error.message);
  return (data as ExecutionJobRow[] | null) ?? [];
}

async function recordTransientFailure(
  job: ExecutionJobRow,
  error: unknown,
  now: Date,
): Promise<WorkerOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempt_count >= job.max_attempts;
  const availableAt = exhausted
    ? job.available_at
    : nextRetryAt(job.attempt_count, now);
  await finishJob(job, {
    status: "failed",
    result: job.result,
    availableAt,
    lastError: message.slice(0, 1000),
    finishedAt: exhausted ? now.toISOString() : null,
    now: now.toISOString(),
    details: {
      error: message.slice(0, 1000),
      exhausted,
      attempt_count: job.attempt_count,
    },
  });
  return {
    jobId: job.id,
    status: "failed",
    attempted: true,
    error: message,
  };
}

export async function processExecutionQueue(params?: {
  limit?: number;
  now?: Date;
}): Promise<ExecutionWorkerSummary> {
  const now = params?.now ?? new Date();
  const limit = Math.max(1, Math.min(25, params?.limit ?? 10));
  const recovered = await recoverStaleRunningJobs(now);
  const claimedJobs = await claimJobs(limit, now);
  const outcomes: WorkerOutcome[] = [];

  for (const claimedJob of claimedJobs) {
    try {
      outcomes.push(await executeClaimedJob(claimedJob, now));
    } catch (executionError) {
      if (executionError instanceof StaleExecutionLeaseError) {
        outcomes.push({
          jobId: claimedJob.id,
          status: "running",
          attempted: false,
          error: executionError.message,
        });
        continue;
      }
      try {
        outcomes.push(
          await recordTransientFailure(claimedJob, executionError, now),
        );
      } catch (failureError) {
        if (!(failureError instanceof StaleExecutionLeaseError)) {
          throw failureError;
        }
        outcomes.push({
          jobId: claimedJob.id,
          status: "running",
          attempted: false,
          error: failureError.message,
        });
      }
    }
  }

  return {
    inspected: claimedJobs.length,
    recovered,
    claimed: claimedJobs.length,
    succeeded: outcomes.filter((item) => item.status === "succeeded").length,
    failed: outcomes.filter((item) => item.status === "failed").length,
    waitingInput: outcomes.filter((item) => item.status === "waiting_input")
      .length,
    canceled: outcomes.filter((item) => item.status === "canceled").length,
    outcomes,
  };
}
