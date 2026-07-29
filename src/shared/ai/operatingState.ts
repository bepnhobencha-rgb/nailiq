import "server-only";

import type { MinhLesson } from "@/shared/ai/lessons";
import { getLessons } from "@/shared/ai/lessons";
import {
  getAiWorkerHeartbeats,
  getAiWorkerRuns,
  type AiWorkerName,
  type AiWorkerRunRow,
  type ExecutionWorkerHeartbeatRow,
} from "@/shared/ai/executionHeartbeat";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type AiQueueCounts = {
  queued: number;
  waitingInput: number;
  running: number;
  failed: number;
  stalled: number;
};

export type AiOperatingHealth = {
  tone: "healthy" | "active" | "attention" | "issue";
  queued: number;
  waitingInput: number;
  running: number;
  failed: number;
  stalled: number;
  activeWork: number;
  needsAttention: number;
  workerIssue: boolean;
};

export type AiExecutionWorkerHealth = {
  status: "healthy" | "running" | "failed" | "stale" | "unknown";
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSucceededAt: string | null;
  lastError: string | null;
};

export type AiWorkerReliability = {
  observedRuns: number;
  completedRuns: number;
  succeededRuns: number;
  failedRuns: number;
  runningRuns: number;
  successRatePct: number | null;
};

export type LearnedAiControl =
  | {
      kind: "proposal_cooldown";
      actionType: string;
      proposalSource: string | null;
      suppressUntil: string;
    }
  | {
      kind: "reduced_pace";
      agent: string;
      capMultiplier: number;
    };

export type AiOperatingState = {
  health: AiOperatingHealth;
  worker: AiExecutionWorkerHealth;
  managerWorker: AiExecutionWorkerHealth;
  workerReliability24h: AiWorkerReliability;
  managerReliability24h: AiWorkerReliability;
  learnedControls: LearnedAiControl[];
  observedAt: string;
};

export function deriveAiOperatingHealth(
  counts: AiQueueCounts,
  worker: AiExecutionWorkerHealth = {
    status: "healthy",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSucceededAt: null,
    lastError: null,
  },
  managerWorker: AiExecutionWorkerHealth = {
    status: "healthy",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSucceededAt: null,
    lastError: null,
  },
): AiOperatingHealth {
  const normalized = {
    queued: Math.max(0, counts.queued),
    waitingInput: Math.max(0, counts.waitingInput),
    running: Math.max(0, counts.running),
    failed: Math.max(0, counts.failed),
    stalled: Math.max(0, counts.stalled),
  };
  const activeWork = normalized.queued + normalized.running;
  const workerIssue = [worker, managerWorker].some(
    (candidate) =>
      candidate.status === "failed" ||
      candidate.status === "stale" ||
      candidate.status === "unknown",
  );
  const needsAttention =
    normalized.waitingInput +
    normalized.failed +
    normalized.stalled +
    (workerIssue ? 1 : 0);
  const tone =
    normalized.failed > 0 || normalized.stalled > 0 || workerIssue
      ? "issue"
      : normalized.waitingInput > 0
        ? "attention"
        : activeWork > 0 ||
            worker.status === "running" ||
            managerWorker.status === "running"
          ? "active"
          : "healthy";

  return { ...normalized, activeWork, needsAttention, workerIssue, tone };
}

export function deriveExecutionWorkerHealth(
  heartbeat: ExecutionWorkerHeartbeatRow | null,
  now = new Date(),
  staleAfterMs = 15 * 60_000,
): AiExecutionWorkerHealth {
  const base = {
    lastStartedAt: heartbeat?.started_at ?? null,
    lastCompletedAt: heartbeat?.completed_at ?? null,
    lastSucceededAt: heartbeat?.succeeded_at ?? null,
    lastError: heartbeat?.last_error ?? null,
  };
  if (!heartbeat || heartbeat.status === "unknown" || !heartbeat.started_at) {
    return { ...base, status: "unknown" };
  }
  const startedAtMs = Date.parse(heartbeat.started_at);
  if (
    !Number.isFinite(startedAtMs) ||
    now.getTime() - startedAtMs > staleAfterMs
  ) {
    return { ...base, status: "stale" };
  }
  if (heartbeat.status === "failed") {
    return { ...base, status: "failed" };
  }
  if (heartbeat.status === "running") {
    return { ...base, status: "running" };
  }
  return { ...base, status: "healthy" };
}

export function deriveWorkerReliability(
  runs: AiWorkerRunRow[],
  workerName: AiWorkerName,
): AiWorkerReliability {
  const workerRuns = runs.filter((run) => run.worker_name === workerName);
  const succeededRuns = workerRuns.filter(
    (run) => run.status === "succeeded",
  ).length;
  const failedRuns = workerRuns.filter((run) => run.status === "failed").length;
  const runningRuns = workerRuns.filter(
    (run) => run.status === "running",
  ).length;
  const completedRuns = succeededRuns + failedRuns;

  return {
    observedRuns: workerRuns.length,
    completedRuns,
    succeededRuns,
    failedRuns,
    runningRuns,
    successRatePct:
      completedRuns > 0
        ? Math.round((succeededRuns / completedRuns) * 100)
        : null,
  };
}

export function deriveLearnedAiControls(
  salonId: string,
  lessons: MinhLesson[],
  now = new Date(),
): LearnedAiControl[] {
  const nowMs = now.getTime();
  const controls: LearnedAiControl[] = [];

  for (const lesson of lessons) {
    // getLessons also returns global lessons. The owner-facing surface must
    // describe only controls learned from this salon's own behavior.
    if (lesson.salonId !== salonId) continue;

    if (lesson.scope === "policy" && lesson.rule === "proposal_cooldown") {
      const actionType = String(lesson.condition.action_type ?? "");
      const suppressUntil = String(lesson.condition.suppress_until ?? "");
      const suppressUntilMs = Date.parse(suppressUntil);
      if (
        !actionType ||
        !Number.isFinite(suppressUntilMs) ||
        suppressUntilMs <= nowMs
      ) {
        continue;
      }
      controls.push({
        kind: "proposal_cooldown",
        actionType,
        proposalSource:
          typeof lesson.condition.proposal_source === "string"
            ? lesson.condition.proposal_source
            : null,
        suppressUntil,
      });
      continue;
    }

    if (lesson.scope === "segment" && lesson.rule.startsWith("cap_multiplier:")) {
      const agent = String(lesson.condition.agent ?? "");
      const capMultiplier = Number(lesson.rule.slice("cap_multiplier:".length));
      if (
        !agent ||
        !Number.isFinite(capMultiplier) ||
        capMultiplier <= 0 ||
        capMultiplier >= 1
      ) {
        continue;
      }
      controls.push({
        kind: "reduced_pace",
        agent,
        capMultiplier: Math.max(0.25, capMultiplier),
      });
    }
  }

  return controls.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "proposal_cooldown" ? -1 : 1;
    }
    if (left.kind === "proposal_cooldown" && right.kind === "proposal_cooldown") {
      return left.suppressUntil.localeCompare(right.suppressUntil);
    }
    return 0;
  });
}

async function countJobs(
  salonId: string,
  status: "queued" | "waiting_input" | "running" | "failed",
  startedBefore?: string,
): Promise<number> {
  const db = createServiceRoleClient();
  let query = db
    .from("ai_execution_jobs" as never)
    .select("id", { count: "exact", head: true })
    .eq("salon_id" as never, salonId)
    .eq("status" as never, status);
  if (startedBefore) {
    query = query.lt("started_at" as never, startedBefore);
  }
  const { count, error } = await query;
  if (error) {
    throw new Error(`ai_execution_${status}_count_failed`, { cause: error });
  }
  return count ?? 0;
}

export async function loadAiOperatingState(
  salonId: string,
  now = new Date(),
): Promise<AiOperatingState> {
  const stalledBefore = new Date(now.getTime() - 15 * 60_000).toISOString();
  const [
    queued,
    waitingInput,
    running,
    failed,
    stalled,
    policy,
    segment,
    heartbeats,
    recentWorkerRuns,
  ] =
    await Promise.all([
      countJobs(salonId, "queued"),
      countJobs(salonId, "waiting_input"),
      countJobs(salonId, "running"),
      countJobs(salonId, "failed"),
      countJobs(salonId, "running", stalledBefore),
      getLessons(salonId, "policy", { throwOnError: true }),
      getLessons(salonId, "segment", { throwOnError: true }),
      getAiWorkerHeartbeats({ throwOnError: true }),
      getAiWorkerRuns(new Date(now.getTime() - 24 * 60 * 60_000), {
        throwOnError: true,
      }),
    ]);
  const worker = deriveExecutionWorkerHealth(
    heartbeats.find((row) => row.worker_name === "ai_execution") ?? null,
    now,
  );
  const managerWorker = deriveExecutionWorkerHealth(
    heartbeats.find((row) => row.worker_name === "ai_manager") ?? null,
    now,
    2 * 60 * 60_000,
  );
  const workerReliability24h = deriveWorkerReliability(
    recentWorkerRuns,
    "ai_execution",
  );
  const managerReliability24h = deriveWorkerReliability(
    recentWorkerRuns,
    "ai_manager",
  );

  return {
    health: deriveAiOperatingHealth({
      queued,
      waitingInput,
      running,
      failed,
      stalled,
    }, worker, managerWorker),
    worker,
    managerWorker,
    workerReliability24h,
    managerReliability24h,
    learnedControls: deriveLearnedAiControls(
      salonId,
      [...policy, ...segment],
      now,
    ),
    observedAt: now.toISOString(),
  };
}
