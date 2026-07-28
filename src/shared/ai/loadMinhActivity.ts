import "server-only";
import {
  deriveOutcomeMeasurement,
  type ObservedOutcome,
} from "@/shared/ai/outcomeMeasurement";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const AGENT_META: Record<string, { icon: string; label: string; trackable: boolean }> = {
  winback:          { icon: "🔄", label: "Kéo Về",       trackable: true  },
  rebook:           { icon: "⏰", label: "Nhịp Tim",      trackable: true  },
  vip_care:         { icon: "👑", label: "VIP Care",      trackable: true  },
  first_visit:      { icon: "🌱", label: "Lần đầu",      trackable: true  },
  watchdog:         { icon: "📡", label: "Radar",         trackable: false },
  social_content:   { icon: "📸", label: "Social",        trackable: false },
  review_responder: { icon: "⭐", label: "Reviews",       trackable: false },
  digest:           { icon: "📋", label: "Digest",        trackable: false },
  strategist:       { icon: "🧠", label: "Chiến Lược",   trackable: false },
  outcome_tracker:  { icon: "📊", label: "Kết quả",      trackable: false },
};

export type MinhLogEntry = {
  id: string;
  agent: string;
  agentIcon: string;
  agentLabel: string;
  actionType: string;
  clientName: string;
  messagePreview: string;
  createdAt: string;
  outcome: "converted" | "no_conversion" | null;
  outcomeAt: string | null;
  trackable: boolean;
};

export type AgentStat = {
  agent: string;
  icon: string;
  label: string;
  sent: number;
  measured: number;
  pending: number;
  converted: number;
  noConversion: number;
  pct: number;
  coveragePct: number;
};

export type MinhActivityData = {
  entries: MinhLogEntry[];
  totalSent: number;
  measured: number;
  measurementCoveragePct: number;
  converted: number;
  pending: number;
  noConversion: number;
  agentStats: AgentStat[];
};

export async function loadMinhActivity(
  salonId: string,
  days = 30,
): Promise<MinhActivityData> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data } = await db
    .from("ai_actions_log" as never)
    .select("id, agent, action_type, payload, created_at, outcome, outcome_at")
    .eq("salon_id", salonId)
    .gte("created_at", since)
    .not("action_type", "in", '("skipped_no_channel","suggestion_pending","digest_sent")')
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as {
    id: string;
    agent: string;
    action_type: string;
    payload: Record<string, unknown> | null;
    created_at: string;
    outcome: string | null;
    outcome_at: string | null;
  }[];

  const entries: MinhLogEntry[] = rows.map((r) => {
    const meta = AGENT_META[r.agent] ?? { icon: "🤖", label: r.agent, trackable: false };
    return {
      id: r.id,
      agent: r.agent,
      agentIcon: meta.icon,
      agentLabel: meta.label,
      actionType: r.action_type,
      clientName: String(r.payload?.name ?? ""),
      messagePreview: String(
        r.payload?.message_preview ??
          r.payload?.title ??
          r.payload?.reasoning ??
          r.payload?.summary ??
          "",
      ),
      createdAt: r.created_at,
      outcome: (r.outcome as "converted" | "no_conversion" | null) ?? null,
      outcomeAt: r.outcome_at,
      trackable: meta.trackable,
    };
  });

  // Stats for trackable agents (winback, rebook, vip_care, first_visit)
  const trackable = entries.filter((e) => e.trackable);
  const overall = deriveOutcomeMeasurement(
    trackable.map((entry) => entry.outcome),
  );

  // Per-agent breakdown
  const agentMap = new Map<string, ObservedOutcome[]>();
  for (const e of trackable) {
    if (!agentMap.has(e.agent)) agentMap.set(e.agent, []);
    agentMap.get(e.agent)!.push(e.outcome);
  }
  const agentStats: AgentStat[] = Array.from(agentMap.entries()).map(
    ([agent, outcomes]) => {
      const meta = AGENT_META[agent] ?? { icon: "🤖", label: agent };
      const measurement = deriveOutcomeMeasurement(outcomes);
      return {
        agent,
        icon: meta.icon,
        label: meta.label,
        sent: measurement.sent,
        measured: measurement.measured,
        pending: measurement.pending,
        converted: measurement.converted,
        noConversion: measurement.noConversion,
        pct: measurement.observedReturnPct ?? 0,
        coveragePct: measurement.coveragePct,
      };
    },
  );

  return {
    entries,
    totalSent: overall.sent,
    measured: overall.measured,
    measurementCoveragePct: overall.coveragePct,
    converted: overall.converted,
    pending: overall.pending,
    noConversion: overall.noConversion,
    agentStats,
  };
}
