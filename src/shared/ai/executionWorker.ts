import "server-only";

import { planExecutionEffect } from "@/shared/ai/executionEffects";
import {
  canRetryExecution,
  nextRetryAt,
  type ExecutionJobStatus,
} from "@/shared/ai/executionPolicy";
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

async function recoverStaleRunningJobs(now: Date): Promise<number> {
  const db = createServiceRoleClient();
  const leaseExpiredAt = new Date(now.getTime() - 15 * 60_000).toISOString();
  const { data, error } = await db
    .from("ai_execution_jobs" as never)
    .update({
      status: "failed",
      available_at: now.toISOString(),
      last_error: "worker_lease_expired",
      finished_at: null,
      updated_at: now.toISOString(),
    } as never)
    .eq("status" as never, "running")
    .lt("started_at" as never, leaseExpiredAt)
    .select("id");
  if (error) throw new Error(error.message);
  return (data as { id: string }[] | null)?.length ?? 0;
}

async function auditTransition(
  job: ExecutionJobRow,
  status: ExecutionJobStatus,
  details: Record<string, unknown>,
) {
  const db = createServiceRoleClient();
  const { error } = await db.from("ai_actions_log" as never).insert({
    salon_id: job.salon_id,
    agent: "ai_execution",
    action_type: `execution_${status}`,
    target_id: job.id,
    payload: {
      approval_request_id: job.approval_request_id,
      requested_action_type: job.action_type,
      ...details,
    },
  } as never);
  if (error) console.error("[executionWorker] audit transition", error);
}

async function finishJob(
  job: ExecutionJobRow,
  patch: Record<string, unknown>,
) {
  const db = createServiceRoleClient();
  const { error } = await db
    .from("ai_execution_jobs" as never)
    .update(patch as never)
    .eq("id" as never, job.id)
    .eq("status" as never, "running");
  if (error) throw new Error(error.message);
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
      last_error: null,
      finished_at: null,
      updated_at: nowIso,
    });
    await auditTransition(job, "waiting_input", { blocker: effect.blocker });
    return { jobId: job.id, status: "waiting_input", attempted: true };
  }

  if (effect.kind === "unsupported") {
    await finishJob(job, {
      status: "canceled",
      result: { reason: effect.reason },
      last_error: effect.reason,
      finished_at: nowIso,
      updated_at: nowIso,
    });
    await auditTransition(job, "canceled", { reason: effect.reason });
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
    last_error: null,
    finished_at: nowIso,
    updated_at: nowIso,
  });
  await auditTransition(job, "succeeded", {
    effect: effect.kind,
    audit_action_type: effect.actionType,
    ...effect.payload,
  });
  return { jobId: job.id, status: "succeeded", attempted: true };
}

async function claimJob(
  candidate: ExecutionJobRow,
  now: Date,
): Promise<ExecutionJobRow | null> {
  const db = createServiceRoleClient();
  const attemptCount = candidate.attempt_count + 1;
  const { data, error } = await db
    .from("ai_execution_jobs" as never)
    .update({
      status: "running",
      attempt_count: attemptCount,
      started_at: now.toISOString(),
      finished_at: null,
      last_error: null,
      updated_at: now.toISOString(),
    } as never)
    .eq("id" as never, candidate.id)
    .eq("status" as never, candidate.status)
    .eq("attempt_count" as never, candidate.attempt_count)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ExecutionJobRow | null) ?? null;
}

async function recordTransientFailure(
  job: ExecutionJobRow,
  error: unknown,
  now: Date,
): Promise<WorkerOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempt_count >= job.max_attempts;
  await finishJob(job, {
    status: "failed",
    available_at: exhausted
      ? job.available_at
      : nextRetryAt(job.attempt_count, now),
    last_error: message.slice(0, 1000),
    finished_at: exhausted ? now.toISOString() : null,
    updated_at: now.toISOString(),
  });
  await auditTransition(job, "failed", {
    error: message.slice(0, 1000),
    exhausted,
    attempt_count: job.attempt_count,
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
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("ai_execution_jobs" as never)
    .select("*")
    .in("status" as never, ["queued", "failed"])
    .lte("available_at" as never, now.toISOString())
    .order("available_at" as never, { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  const candidates = (data as ExecutionJobRow[] | null) ?? [];
  const outcomes: WorkerOutcome[] = [];
  let claimed = 0;

  for (const candidate of candidates) {
    if (
      !canRetryExecution({
        status: candidate.status,
        attemptCount: candidate.attempt_count,
        maxAttempts: candidate.max_attempts,
        availableAt: candidate.available_at,
        now,
      })
    ) {
      outcomes.push({
        jobId: candidate.id,
        status: candidate.status,
        attempted: false,
      });
      continue;
    }

    let claimedJob: ExecutionJobRow | null;
    try {
      claimedJob = await claimJob(candidate, now);
    } catch (claimError) {
      outcomes.push({
        jobId: candidate.id,
        status: candidate.status,
        attempted: false,
        error:
          claimError instanceof Error ? claimError.message : String(claimError),
      });
      continue;
    }
    if (!claimedJob) continue;
    claimed++;

    try {
      outcomes.push(await executeClaimedJob(claimedJob, now));
    } catch (executionError) {
      outcomes.push(
        await recordTransientFailure(claimedJob, executionError, now),
      );
    }
  }

  return {
    inspected: candidates.length,
    recovered,
    claimed,
    succeeded: outcomes.filter((item) => item.status === "succeeded").length,
    failed: outcomes.filter((item) => item.status === "failed").length,
    waitingInput: outcomes.filter((item) => item.status === "waiting_input")
      .length,
    canceled: outcomes.filter((item) => item.status === "canceled").length,
    outcomes,
  };
}
