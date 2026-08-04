import "server-only";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";

export type CertificationStatus =
  | "certified"
  | "waiting_data"
  | "not_configured"
  | "failed";

type SalonRow = {
  id: string;
  name: string;
  slug: string;
  feature_flags: Record<string, unknown> | null;
  voice_ai_enabled: boolean | null;
  google_place_id: string | null;
  yelp_business_id: string | null;
};

type EvidenceRow = {
  salon_id: string;
  agent?: string | null;
  feature?: string | null;
  status?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  outcome_at?: string | null;
};

type AgentDefinition = {
  key: string;
  label: string;
  cadence: string;
  failureKey: string;
  configured: (salon: SalonRow) => boolean;
  evidence: (input: EvidenceInput, salonId: string) => EvidenceRow[];
};

type EvidenceInput = {
  actions: EvidenceRow[];
  usage: EvidenceRow[];
  voice: EvidenceRow[];
  policies: EvidenceRow[];
  notifications: EvidenceRow[];
  jobs: EvidenceRow[];
};

export type AgentCertificationRow = {
  salonId: string;
  salonName: string;
  slug: string;
  agent: string;
  agentLabel: string;
  cadence: string;
  status: CertificationStatus;
  evidenceCount: number;
  lastEvidenceAt: string | null;
  reason: string;
};

export type AgentCertificationData = {
  windowDays: number;
  generatedAt: string;
  latestManagerRunAt: string | null;
  matrix: AgentCertificationRow[];
  counts: Record<CertificationStatus, number>;
  truncated: boolean;
};

const flag = (key: string) => (salon: SalonRow) => salon.feature_flags?.[key] === true;
const always = () => true;
const actionEvidence = (agent: string) => (input: EvidenceInput, salonId: string) =>
  input.actions.filter((row) => row.salon_id === salonId && row.agent === agent);
const usageEvidence = (features: string[]) => (input: EvidenceInput, salonId: string) =>
  input.usage.filter((row) => row.salon_id === salonId && features.includes(row.feature ?? ""));

const AGENTS: readonly AgentDefinition[] = [
  { key: "outcome_tracker", label: "Outcome Tracker", cadence: "Daily", failureKey: "outcome_tracker", configured: always, evidence: (input, salonId) => input.actions.filter((row) => row.salon_id === salonId && Boolean(row.outcome_at)) },
  { key: "cancellation_radar", label: "Cancellation Radar", cadence: "Daily", failureKey: "cancellation_radar", configured: flag("ai_cancellation_radar"), evidence: actionEvidence("cancellation_radar") },
  { key: "revenue_report", label: "Revenue Report", cadence: "Weekly", failureKey: "revenue_report", configured: flag("ai_revenue_report"), evidence: actionEvidence("revenue_report") },
  { key: "staff_performance", label: "Staff Performance", cadence: "Weekly", failureKey: "staff_performance", configured: flag("ai_staff_performance"), evidence: actionEvidence("staff_performance") },
  { key: "noshow", label: "No-show Policy", cadence: "Hourly / event-driven", failureKey: "noshow", configured: (salon) => salon.feature_flags?.ai_noshow_policy_live === true || salon.feature_flags?.ai_noshow_policy_shadow === true, evidence: (input, salonId) => [...usageEvidence(["noshow_policy", "noshow_risk_score"])(input, salonId), ...input.policies.filter((row) => row.salon_id === salonId)] },
  { key: "watchdog", label: "Watchdog", cadence: "Condition-based", failureKey: "watchdog", configured: flag("ai_watchdog"), evidence: usageEvidence(["watchdog"]) },
  { key: "winback", label: "Win-back", cadence: "Hourly, deduped", failureKey: "winback", configured: flag("ai_winback"), evidence: actionEvidence("winback") },
  { key: "rebook", label: "Rebook", cadence: "Hourly, deduped", failureKey: "rebook", configured: flag("ai_rebook"), evidence: actionEvidence("rebook") },
  { key: "digest", label: "Unified Digest", cadence: "Daily at 21:00", failureKey: "digest", configured: flag("ai_unified_digest"), evidence: actionEvidence("digest") },
  { key: "social_content", label: "Social Content", cadence: "Mon/Wed/Fri", failureKey: "social_content", configured: flag("ai_social_content"), evidence: actionEvidence("social_content") },
  { key: "vip_care", label: "VIP Care", cadence: "Daily, eligibility-based", failureKey: "vip_care", configured: flag("ai_vip_care"), evidence: actionEvidence("vip_care") },
  { key: "strategist", label: "Strategist", cadence: "Weekly", failureKey: "strategist", configured: always, evidence: actionEvidence("strategist") },
  { key: "review_responder", label: "Google Review Responder", cadence: "Every 4 hours", failureKey: "review_responder", configured: (salon) => Boolean(salon.google_place_id), evidence: actionEvidence("review_responder") },
  { key: "yelp_responder", label: "Yelp Responder", cadence: "Every 4 hours", failureKey: "yelp_responder", configured: (salon) => salon.feature_flags?.ai_yelp_reply === true && Boolean(salon.yelp_business_id), evidence: actionEvidence("yelp_responder") },
  { key: "gbp_post", label: "Google Business Post", cadence: "1st and 15th", failureKey: "gbp_post", configured: (salon) => salon.feature_flags?.ai_gbp_post === true && Boolean(salon.google_place_id), evidence: actionEvidence("gbp_post") },
  { key: "first_visit", label: "First Visit Nurture", cadence: "Daily", failureKey: "first_visit", configured: flag("ai_first_visit_nurture"), evidence: actionEvidence("first_visit") },
  { key: "smart_reminders", label: "Smart Reminders", cadence: "Scheduled", failureKey: "smart_reminders", configured: flag("ai_smart_reminders"), evidence: (input, salonId) => input.notifications.filter((row) => row.salon_id === salonId) },
  { key: "ai_execution", label: "AI Execution", cadence: "Every 5 minutes", failureKey: "ai_execution", configured: flag("ai_control_center_enabled"), evidence: (input, salonId) => input.jobs.filter((row) => row.salon_id === salonId) },
  { key: "voice_ai", label: "AI Receptionist", cadence: "Event-driven", failureKey: "voice_ai", configured: (salon) => salon.voice_ai_enabled === true, evidence: (input, salonId) => input.voice.filter((row) => row.salon_id === salonId) },
];

function evidenceAt(row: EvidenceRow): string | null {
  return row.created_at ?? row.started_at ?? row.outcome_at ?? null;
}

export function buildAgentCertificationMatrix(input: {
  salons: SalonRow[];
  evidence: EvidenceInput;
  failedAgents: Set<string>;
}): AgentCertificationRow[] {
  return input.salons.flatMap((salon) => AGENTS.map((agent) => {
    const configured = agent.configured(salon);
    const evidence = configured ? agent.evidence(input.evidence, salon.id) : [];
    const latest = evidence
      .map(evidenceAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    const failed = input.failedAgents.has(`${salon.slug}:${agent.failureKey}`);
    const status: CertificationStatus = !configured
      ? "not_configured"
      : failed
        ? "failed"
        : evidence.length > 0
          ? "certified"
          : "waiting_data";
    const reason = status === "not_configured"
      ? "Required feature flag or provider configuration is missing."
      : status === "failed"
        ? "The latest AI Manager run reported this agent as failed."
        : status === "certified"
          ? "Production evidence exists inside the 30-day certification window."
          : "Configured, but no eligible production event has occurred in the window.";
    return {
      salonId: salon.id,
      salonName: salon.name,
      slug: salon.slug,
      agent: agent.key,
      agentLabel: agent.label,
      cadence: agent.cadence,
      status,
      evidenceCount: evidence.length,
      lastEvidenceAt: latest,
      reason,
    };
  }));
}

async function isSuperadmin(): Promise<boolean> {
  const db = await createClient();
  const { data } = await db.auth.getUser();
  return Boolean(data.user && await getSuperAdminRole(data.user.id));
}

export async function loadAgentCertificationMatrix(): Promise<
  { ok: true; data: AgentCertificationData } |
  { ok: false; error: "unauthorized" | "unavailable" }
> {
  if (!(await isSuperadmin())) return { ok: false, error: "unauthorized" };
  try {
    const db = createServiceRoleClient();
    const generatedAt = new Date().toISOString();
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const limit = 10_000;
    const [salons, actions, usage, voice, policies, notifications, jobs, managerRuns, workerStates] = await Promise.all([
      db.from("salons").select("id, name, slug, feature_flags, voice_ai_enabled, google_place_id, yelp_business_id").is("archived_at", null).order("name"),
      db.from("ai_actions_log" as never).select("salon_id, agent, created_at, outcome_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("ai_usage_events" as never).select("salon_id, feature, status, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("voice_ai_sessions" as never).select("salon_id, status, started_at" as never).gte("started_at" as never, since).limit(limit),
      db.from("ai_policy_decisions" as never).select("salon_id, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("booking_notifications" as never).select("salon_id, status, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("ai_execution_jobs" as never).select("salon_id, status, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("ai_worker_runs" as never).select("started_at, status, summary" as never).eq("worker_name" as never, "ai_manager").order("started_at" as never, { ascending: false }).limit(1),
      db.from("ai_execution_worker_state" as never).select("worker_name, status" as never).in("worker_name" as never, ["ai_execution", "reminders"]),
    ]);
    const results = [salons, actions, usage, voice, policies, notifications, jobs, managerRuns, workerStates];
    if (results.some((result) => result.error)) {
      console.error("[superadmin/agent-certification] query unavailable", results.map((result) => result.error?.code ?? null));
      return { ok: false, error: "unavailable" };
    }
    const latestRun = (managerRuns.data?.[0] ?? null) as { started_at?: string; summary?: { failed_agents?: unknown } } | null;
    const failedAgents = new Set(
      Array.isArray(latestRun?.summary?.failed_agents)
        ? latestRun.summary.failed_agents.filter((value): value is string => typeof value === "string")
        : [],
    );
    const failedWorkers = new Set(
      ((workerStates.data ?? []) as unknown as Array<{ worker_name: string; status: string }>)
        .filter((row) => row.status === "failed")
        .map((row) => row.worker_name),
    );
    for (const salon of (salons.data ?? []) as SalonRow[]) {
      if (failedWorkers.has("ai_execution")) failedAgents.add(`${salon.slug}:ai_execution`);
      if (failedWorkers.has("reminders")) failedAgents.add(`${salon.slug}:smart_reminders`);
    }
    const matrix = buildAgentCertificationMatrix({
      salons: (salons.data ?? []) as SalonRow[],
      evidence: {
        actions: (actions.data ?? []) as unknown as EvidenceRow[],
        usage: (usage.data ?? []) as unknown as EvidenceRow[],
        voice: (voice.data ?? []) as unknown as EvidenceRow[],
        policies: (policies.data ?? []) as unknown as EvidenceRow[],
        notifications: (notifications.data ?? []) as unknown as EvidenceRow[],
        jobs: (jobs.data ?? []) as unknown as EvidenceRow[],
      },
      failedAgents,
    });
    const counts: Record<CertificationStatus, number> = {
      certified: 0,
      waiting_data: 0,
      not_configured: 0,
      failed: 0,
    };
    for (const row of matrix) counts[row.status]++;
    return { ok: true, data: {
      windowDays: 30,
      generatedAt,
      latestManagerRunAt: latestRun?.started_at ?? null,
      matrix,
      counts,
      truncated: [actions, usage, voice, policies, notifications, jobs]
        .some((result) => (result.data?.length ?? 0) === limit),
    } };
  } catch (error) {
    console.error("[superadmin/agent-certification] unavailable", error);
    return { ok: false, error: "unavailable" };
  }
}
