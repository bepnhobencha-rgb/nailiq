import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getLessons } from "./lessons";
import { decreaseLessonConfidence } from "./lessonMutations";

const CONVERSION_RATE_THRESHOLD = 0.05; // 5% — very low; warrants a confidence decrease
const MIN_SAMPLE_SIZE = 10; // need at least 10 resolved actions to act
const CONFIDENCE_DELTA = 0.05; // minor signal, needs more data

// Scopes checked for low-performing agents
const AGENT_LESSON_SCOPES = ["timing", "channel", "segment"] as const;

export type AgentStat = {
  sent: number;
  converted: number;
  conversionRate: number;
};

export type OutcomeAnalysisResult = {
  agentStats: Record<string, AgentStat>;
  lessonsAdjusted: number;
};

/**
 * Reads ai_actions_log outcomes for the past 30 days and adjusts lesson
 * confidence for agents with very low conversion rates (<5%).
 *
 * The signal is minor: we only apply a small delta (0.05) per agent so that
 * a single bad month doesn't deactivate an otherwise sound lesson.
 * Logs every adjustment to ai_actions_log for audit trail.
 */
export async function analyzeAgentOutcomes(
  salonId: string,
): Promise<OutcomeAnalysisResult> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Fetch resolved actions (those with a non-null outcome)
  const { data: rows, error } = await db
    .from("ai_actions_log" as never)
    .select("agent, outcome")
    .eq("salon_id" as never, salonId)
    .eq("action_type" as never, "sent")
    .not("outcome" as never, "is", null)
    .gte("created_at" as never, since);

  if (error) {
    console.error("[analyzeAgentOutcomes] query", salonId, error);
    return { agentStats: {}, lessonsAdjusted: 0 };
  }

  // Aggregate per agent
  const statMap = new Map<string, { sent: number; converted: number }>();
  for (const r of (rows ?? []) as { agent: string; outcome: string }[]) {
    if (!statMap.has(r.agent)) statMap.set(r.agent, { sent: 0, converted: 0 });
    const s = statMap.get(r.agent)!;
    s.sent++;
    if (r.outcome === "converted") s.converted++;
  }

  const agentStats: Record<string, AgentStat> = {};
  for (const [agent, s] of statMap.entries()) {
    agentStats[agent] = {
      sent: s.sent,
      converted: s.converted,
      conversionRate: s.sent > 0 ? s.converted / s.sent : 0,
    };
  }

  let lessonsAdjusted = 0;

  for (const [agent, stat] of Object.entries(agentStats)) {
    if (
      stat.sent < MIN_SAMPLE_SIZE ||
      stat.conversionRate >= CONVERSION_RATE_THRESHOLD
    ) {
      continue;
    }

    // Low conversion — find lessons associated with this agent's scopes
    const lessonsForAgent: string[] = [];

    for (const scope of AGENT_LESSON_SCOPES) {
      const lessons = await getLessons(salonId, scope);
      for (const lesson of lessons) {
        // Target lessons that either explicitly mention this agent or are general
        const cond = lesson.condition as Record<string, unknown>;
        const agentMatch = !cond.agent || cond.agent === agent;
        if (agentMatch) {
          lessonsForAgent.push(lesson.id);
        }
      }
    }

    for (const lessonId of lessonsForAgent) {
      await decreaseLessonConfidence(lessonId, CONFIDENCE_DELTA);
      lessonsAdjusted++;

      // Log the adjustment
      await db.from("ai_actions_log" as never).insert({
        salon_id: salonId,
        agent: "minh_self_learn",
        action_type: "lesson_confidence_adjusted",
        target_id: lessonId,
        payload: {
          reason: "low_conversion",
          agent_assessed: agent,
          conversion_rate: stat.conversionRate,
          sent: stat.sent,
          converted: stat.converted,
          delta: -CONFIDENCE_DELTA,
        },
      } as never);
    }
  }

  return { agentStats, lessonsAdjusted };
}
