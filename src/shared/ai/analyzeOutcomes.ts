import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { setOutcomeAdaptation } from "./lessonMutations";

const REDUCE_THRESHOLD = 0.05;
const RECOVER_THRESHOLD = 0.1;
const MIN_SAMPLE_SIZE = 10;
const ADAPTIVE_AGENTS = new Set(["winback", "rebook", "first_visit", "vip_care"]);

export type AgentStat = {
  sent: number;
  converted: number;
  conversionRate: number;
};

export type OutcomeAnalysisResult = {
  agentStats: Record<string, AgentStat>;
  lessonsAdjusted: number;
  adaptationsActivated: number;
  adaptationsRecovered: number;
};

/**
 * Decide whether a statistically meaningful agent sample should reduce,
 * recover, or preserve its current learned cap. The gap between 5% and 10% is
 * hysteresis so a noisy day cannot flip behavior back and forth.
 */
export function decideOutcomeAdaptation(stat: AgentStat):
  | "activate"
  | "recover"
  | "unchanged" {
  if (stat.sent < MIN_SAMPLE_SIZE) return "unchanged";
  if (stat.conversionRate < REDUCE_THRESHOLD) return "activate";
  if (stat.conversionRate >= RECOVER_THRESHOLD) return "recover";
  return "unchanged";
}

/**
 * Reads resolved outcomes from the last 30 days and turns them into a bounded,
 * reversible cap lesson. This does not send anything and cannot raise a code cap.
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
    // Real send types vary per agent (sent_sms, warmth_sent, step{N}_sent,
    // birthday, milestone_{N}, vip_inactive); the only non-send marker is
    // skipped_no_channel. Excluding it — instead of matching a literal "sent"
    // that no agent writes — is what makes the self-learning loop see data.
    .neq("action_type" as never, "skipped_no_channel")
    .not("outcome" as never, "is", null)
    .gte("created_at" as never, since);

  if (error) {
    console.error("[analyzeAgentOutcomes] query", salonId, error);
    return {
      agentStats: {},
      lessonsAdjusted: 0,
      adaptationsActivated: 0,
      adaptationsRecovered: 0,
    };
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
  let adaptationsActivated = 0;
  let adaptationsRecovered = 0;

  for (const [agent, stat] of Object.entries(agentStats)) {
    if (!ADAPTIVE_AGENTS.has(agent)) continue;
    const decision = decideOutcomeAdaptation(stat);
    if (decision === "unchanged") continue;

    const mutation = await setOutcomeAdaptation({
      salonId,
      agent,
      active: decision === "activate",
      capMultiplier: 0.5,
    });
    if (!mutation.changed) continue;

    lessonsAdjusted++;
    if (decision === "activate") adaptationsActivated++;
    else adaptationsRecovered++;
    await db.from("ai_actions_log" as never).insert({
      salon_id: salonId,
      agent: "minh_self_learn",
      action_type:
        decision === "activate"
          ? "outcome_adaptation_activated"
          : "outcome_adaptation_recovered",
      target_id: mutation.lessonId,
      payload: {
        agent_assessed: agent,
        conversion_rate: stat.conversionRate,
        sent: stat.sent,
        converted: stat.converted,
        cap_multiplier: decision === "activate" ? 0.5 : 1,
      },
    } as never);
  }

  return {
    agentStats,
    lessonsAdjusted,
    adaptationsActivated,
    adaptationsRecovered,
  };
}
