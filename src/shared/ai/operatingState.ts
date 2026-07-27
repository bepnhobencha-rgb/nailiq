import "server-only";

import type { MinhLesson } from "@/shared/ai/lessons";
import { getLessons } from "@/shared/ai/lessons";
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
  learnedControls: LearnedAiControl[];
  observedAt: string;
};

export function deriveAiOperatingHealth(
  counts: AiQueueCounts,
): AiOperatingHealth {
  const normalized = {
    queued: Math.max(0, counts.queued),
    waitingInput: Math.max(0, counts.waitingInput),
    running: Math.max(0, counts.running),
    failed: Math.max(0, counts.failed),
    stalled: Math.max(0, counts.stalled),
  };
  const activeWork = normalized.queued + normalized.running;
  const needsAttention =
    normalized.waitingInput + normalized.failed + normalized.stalled;
  const tone =
    normalized.failed > 0 || normalized.stalled > 0
      ? "issue"
      : normalized.waitingInput > 0
        ? "attention"
        : activeWork > 0
          ? "active"
          : "healthy";

  return { ...normalized, activeWork, needsAttention, tone };
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
    console.error("[loadAiOperatingState] queue count", status, error);
    return 0;
  }
  return count ?? 0;
}

export async function loadAiOperatingState(
  salonId: string,
  now = new Date(),
): Promise<AiOperatingState> {
  const stalledBefore = new Date(now.getTime() - 15 * 60_000).toISOString();
  const [queued, waitingInput, running, failed, stalled, policy, segment] =
    await Promise.all([
      countJobs(salonId, "queued"),
      countJobs(salonId, "waiting_input"),
      countJobs(salonId, "running"),
      countJobs(salonId, "failed"),
      countJobs(salonId, "running", stalledBefore),
      getLessons(salonId, "policy"),
      getLessons(salonId, "segment"),
    ]);

  return {
    health: deriveAiOperatingHealth({
      queued,
      waitingInput,
      running,
      failed,
      stalled,
    }),
    learnedControls: deriveLearnedAiControls(
      salonId,
      [...policy, ...segment],
      now,
    ),
    observedAt: now.toISOString(),
  };
}
