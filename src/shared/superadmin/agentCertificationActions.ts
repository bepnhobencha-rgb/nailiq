import "server-only";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { SESSION_TTL_SECONDS } from "@/shared/voiceai/config";

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
  action_type?: string | null;
  feature?: string | null;
  status?: string | null;
  model?: string | null;
  realtime_usage?: unknown;
  estimated_cost_usd?: number | string | null;
  created_at?: string | null;
  started_at?: string | null;
  outcome_at?: string | null;
};

type ActiveAgentExceptionRow = {
  salon_id: string;
  source_ref: string | null;
  status: string;
};

type AgentDefinition = {
  key: string;
  label: string;
  cadence: string;
  failureKey: string;
  configured: (salon: SalonRow) => boolean;
  evidence: (input: EvidenceInput, salonId: string) => EvidenceRow[];
  contract: AgentOperatingContract;
};

export type AgentOperatingContract = {
  trigger: string;
  permission: string;
  inputs: string;
  outputs: string;
  audit: string;
  retry: string;
  cost: string;
};

type EvidenceInput = {
  actions: EvidenceRow[];
  usage: EvidenceRow[];
  voice: EvidenceRow[];
  policies: EvidenceRow[];
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
  contract: AgentOperatingContract;
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
  input.actions.filter(
    (row) =>
      row.salon_id === salonId &&
      row.agent === agent &&
      row.action_type !== "skipped_no_channel",
  );
const usageEvidence = (features: string[]) => (input: EvidenceInput, salonId: string) =>
  input.usage.filter(
    (row) =>
      row.salon_id === salonId &&
      features.includes(row.feature ?? "") &&
      row.status === "succeeded",
  );

function hasCompleteVoiceTelemetry(row: EvidenceRow): boolean {
  if (row.status !== "completed" || !row.model?.trim()) return false;
  if (row.estimated_cost_usd == null) return false;
  if (!row.realtime_usage || typeof row.realtime_usage !== "object") return false;
  return (row.realtime_usage as { schemaVersion?: unknown }).schemaVersion === 1;
}

export function staleVoiceSessionSalonIds(
  rows: EvidenceRow[],
  now = new Date(),
): Set<string> {
  const staleBefore =
    now.getTime() - (SESSION_TTL_SECONDS + 5 * 60) * 1_000;
  return new Set(
    rows
      .filter(
        (row) =>
          row.status === "active" &&
          Boolean(row.started_at) &&
          Date.parse(row.started_at!) < staleBefore,
      )
      .map((row) => row.salon_id),
  );
}

export function activeAgentFailureKeys(
  rows: ActiveAgentExceptionRow[],
  salonSlugById: Map<string, string>,
): Set<string> {
  const failures = new Set<string>();
  for (const row of rows) {
    const slug = salonSlugById.get(row.salon_id);
    if (
      slug &&
      row.source_ref &&
      ["open", "acknowledged"].includes(row.status)
    ) {
      failures.add(`${slug}:${row.source_ref}`);
    }
  }
  return failures;
}

const AGENTS: readonly AgentDefinition[] = [
  {
    key: "outcome_tracker", label: "Outcome Tracker", cadence: "Daily at 09:00", failureKey: "outcome_tracker", configured: always,
    evidence: (input, salonId) => input.actions.filter((row) => row.salon_id === salonId && Boolean(row.outcome_at)),
    contract: { trigger: "AI Manager at 09:00 salon time", permission: "Eligible active tenant; no outbound permission", inputs: "Delivered AI actions, bookings, completed appointments and revenue", outputs: "Converted / no-conversion attribution and ROI metrics", audit: "ai_actions_log.outcome + outcome_at", retry: "Idempotent; next eligible Manager cycle", cost: "Rule-first; no direct model call" },
  },
  {
    key: "cancellation_radar", label: "Cancellation Radar", cadence: "Daily at 09:00", failureKey: "cancellation_radar", configured: flag("ai_cancellation_radar"), evidence: actionEvidence("cancellation_radar"),
    contract: { trigger: "AI Manager daily; full pattern report on Monday", permission: "Feature flag ai_cancellation_radar", inputs: "Cancellation volume, timing and service patterns", outputs: "Owner alert or digest entry", audit: "ai_actions_log (cancellation_radar)", retry: "Deduped; retries on the next daily cycle", cost: "Rule-first analytics; no direct model call" },
  },
  {
    key: "daily_report", label: "Daily Report", cadence: "Daily at 21:00", failureKey: "daily_report", configured: (salon) => salon.feature_flags?.ai_unified_digest !== true, evidence: actionEvidence("daily_report"),
    contract: { trigger: "AI Manager at 21:00 salon time", permission: "Active unless Unified Digest replaces it", inputs: "Daily bookings, revenue, client and staff summary", outputs: "Localized owner report", audit: "ai_actions_log (daily_report)", retry: "Daily idempotency; provider failures retry next cycle", cost: "ai_usage_events feature daily_report" },
  },
  {
    key: "revenue_report", label: "Revenue Report", cadence: "Monday at 09:00", failureKey: "revenue_report", configured: flag("ai_revenue_report"), evidence: actionEvidence("revenue_report"),
    contract: { trigger: "AI Manager Monday at 09:00 salon time", permission: "Feature flag ai_revenue_report", inputs: "Weekly booking, service and revenue aggregates", outputs: "Owner revenue narrative", audit: "ai_actions_log (revenue_report)", retry: "Weekly dedupe; next eligible Manager cycle", cost: "ai_usage_events feature revenue_report" },
  },
  {
    key: "staff_performance", label: "Staff Performance", cadence: "Monday at 09:00", failureKey: "staff_performance", configured: flag("ai_staff_performance"), evidence: actionEvidence("staff_performance"),
    contract: { trigger: "AI Manager Monday at 09:00 salon time", permission: "Feature flag ai_staff_performance", inputs: "Staff bookings, completion and revenue aggregates", outputs: "Owner performance summary", audit: "ai_actions_log (staff_performance)", retry: "Weekly dedupe; next eligible Manager cycle", cost: "ai_usage_events feature staff_performance" },
  },
  {
    key: "noshow", label: "No-show Policy", cadence: "Hourly / event-driven", failureKey: "noshow", configured: (salon) => salon.feature_flags?.ai_noshow_policy_live === true || salon.feature_flags?.ai_noshow_policy_shadow === true, evidence: (input, salonId) => [...usageEvidence(["noshow_policy", "noshow_risk_score"])(input, salonId), ...input.policies.filter((row) => row.salon_id === salonId)],
    contract: { trigger: "Booking risk event plus hourly backfill", permission: "Owner/Admin flag; shadow or acknowledged live mode", inputs: "Salon policy, booking value and no-show history", outputs: "Guarded card/deposit recommendation; live mode may set requirement", audit: "ai_policy_decisions + ai_usage_events", retry: "Rule fallback on model failure; backfill is idempotent", cost: "ai_usage_events features noshow_policy / noshow_risk_score" },
  },
  {
    key: "watchdog", label: "Watchdog", cadence: "Condition-based, ≤12-hour alerts", failureKey: "watchdog", configured: flag("ai_watchdog"), evidence: usageEvidence(["watchdog"]),
    contract: { trigger: "AI Manager when a material operating signal exists", permission: "Feature flag ai_watchdog", inputs: "Booking, queue and operational exception signals", outputs: "Bounded owner alert or digest signal", audit: "watchdog_alerts + ai_usage_events", retry: "12-hour dedupe; next Manager cycle", cost: "ai_usage_events feature watchdog; rule-first skip when quiet" },
  },
  {
    key: "winback", label: "Win-back", cadence: "Hourly, deduped", failureKey: "winback", configured: flag("ai_winback"), evidence: actionEvidence("winback"),
    contract: { trigger: "AI Manager when a lapsed eligible client exists", permission: "Owner/Admin outbound acknowledgement + ai_winback", inputs: "Visit history, consent, channel and salon voice", outputs: "Capped SMS/email win-back message", audit: "ai_actions_log (winback) + outcome", retry: "30-day dedupe, per-run cap, permission re-check before send", cost: "ai_usage_events feature winback_draft" },
  },
  {
    key: "rebook", label: "Rebook", cadence: "Hourly, deduped", failureKey: "rebook", configured: flag("ai_rebook"), evidence: actionEvidence("rebook"),
    contract: { trigger: "AI Manager when a client reaches normal rebook rhythm", permission: "Owner/Admin outbound acknowledgement + ai_rebook", inputs: "Completed visits, cadence, consent and channel", outputs: "Capped SMS/email rebook message", audit: "ai_actions_log (rebook) + outcome", retry: "Deduped with per-run cap; permission re-check before send", cost: "ai_usage_events feature rebook_draft" },
  },
  {
    key: "digest", label: "Unified Digest", cadence: "Daily at 21:00", failureKey: "digest", configured: flag("ai_unified_digest"), evidence: actionEvidence("digest"),
    contract: { trigger: "AI Manager at 21:00 when material content exists", permission: "Feature flag ai_unified_digest", inputs: "Agent actions, alerts, outcomes, bookings and pending approvals", outputs: "One localized owner email", audit: "record_ai_digest_delivery + ai_actions_log", retry: "Daily delivery idempotency; no duplicate after provider acceptance", cost: "ai_usage_events feature digest; rule-first skips quiet days" },
  },
  {
    key: "social_content", label: "Social Content", cadence: "Mon/Wed/Fri at 08:00", failureKey: "social_content", configured: flag("ai_social_content"), evidence: actionEvidence("social_content"),
    contract: { trigger: "AI Manager on content days", permission: "Feature flag ai_social_content; draft-only", inputs: "Salon profile, services, offers and brand voice", outputs: "Owner-reviewable social caption draft", audit: "ai_actions_log (social_content)", retry: "Date-based dedupe; next content day", cost: "ai_usage_events feature social_content" },
  },
  {
    key: "vip_care", label: "VIP Care", cadence: "Daily at 08:00, eligibility-based", failureKey: "vip_care", configured: flag("ai_vip_care"), evidence: actionEvidence("vip_care"),
    contract: { trigger: "Birthday, milestone or inactivity eligibility", permission: "Owner/Admin outbound acknowledgement + ai_vip_care", inputs: "Client milestones, consent, channel and rewards", outputs: "Capped localized VIP SMS/email", audit: "ai_actions_log (vip_care) + outcome", retry: "Per-run cap, durable dedupe, permission re-check before send", cost: "ai_usage_events feature vip_care_draft" },
  },
  {
    key: "strategist", label: "Strategist", cadence: "Sunday at 21:00", failureKey: "strategist", configured: always, evidence: actionEvidence("strategist"),
    contract: { trigger: "AI Manager Sunday at 21:00 salon time", permission: "Eligible active tenant; risky actions require approval", inputs: "Salon intelligence profile and recent operating trends", outputs: "Recommendation, draft or approval request; never silent execution", audit: "ai_actions_log + approval_requests", retry: "Weekly dedupe; next eligible cycle", cost: "ai_usage_events feature strategist" },
  },
  {
    key: "review_responder", label: "Google Review Responder", cadence: "08/12/16/20 salon time", failureKey: "review_responder", configured: (salon) => salon.feature_flags?.ai_google_reply === true && Boolean(salon.google_place_id), evidence: actionEvidence("review_responder"),
    contract: { trigger: "Google review poll every four hours", permission: "ai_google_reply + Google Place configuration", inputs: "Unanswered Google review and salon identity", outputs: "Reply draft / provider action under configured policy", audit: "ai_actions_log (review_responder)", retry: "Review timestamp dedupe; next polling cycle", cost: "ai_usage_events feature review_responder" },
  },
  {
    key: "yelp_responder", label: "Yelp Responder", cadence: "08/12/16/20 salon time", failureKey: "yelp_responder", configured: (salon) => salon.feature_flags?.ai_yelp_reply === true && Boolean(salon.yelp_business_id), evidence: actionEvidence("yelp_responder"),
    contract: { trigger: "Yelp review poll every four hours", permission: "ai_yelp_reply + Yelp Business configuration", inputs: "Unanswered Yelp review and salon voice", outputs: "Owner-reviewable Yelp reply draft", audit: "ai_actions_log (yelp_responder)", retry: "Review ID dedupe; next polling cycle", cost: "ai_usage_events feature yelp_responder" },
  },
  {
    key: "gbp_post", label: "Google Business Post", cadence: "1st/15th at 10:00", failureKey: "gbp_post", configured: (salon) => salon.feature_flags?.ai_gbp_post === true && Boolean(salon.google_place_id), evidence: actionEvidence("gbp_post"),
    contract: { trigger: "AI Manager on the 1st and 15th", permission: "ai_gbp_post + Google Place; draft-only", inputs: "Salon profile, service mix and recent activity", outputs: "Owner-reviewable Google Business post draft", audit: "ai_actions_log (gbp_post)", retry: "Period dedupe; next scheduled date", cost: "ai_usage_events feature gbp_post" },
  },
  {
    key: "first_visit", label: "First Visit Nurture", cadence: "Daily at 20:00", failureKey: "first_visit", configured: flag("ai_first_visit_nurture"), evidence: actionEvidence("first_visit"),
    contract: { trigger: "Same-day first visit and follow-up sequence eligibility", permission: "Owner/Admin outbound acknowledgement + ai_first_visit_nurture", inputs: "First completed visit, consent, channel and language", outputs: "Capped warmth/follow-up SMS or email", audit: "ai_actions_log (first_visit) + outcome", retry: "Step/state dedupe; permission and consent re-check before each send", cost: "ai_usage_events feature first_visit_draft" },
  },
  {
    key: "smart_reminders", label: "Smart Reminders", cadence: "Scheduled before appointments", failureKey: "smart_reminders", configured: flag("ai_smart_reminders"), evidence: usageEvidence(["smart_reminder"]),
    contract: { trigger: "Reminder scheduler for an eligible upcoming booking", permission: "ai_smart_reminders + channel consent/settings", inputs: "Appointment, policy, client language and risk context", outputs: "Personalized reminder content", audit: "ai_usage_events + pending notification delivery log", retry: "Notification queue retry; deterministic reminder window", cost: "ai_usage_events feature smart_reminder" },
  },
  {
    key: "ai_execution", label: "AI Execution", cadence: "Every 5 minutes", failureKey: "ai_execution", configured: flag("ai_control_center_enabled"), evidence: (input, salonId) => input.jobs.filter((row) => row.salon_id === salonId && row.status === "succeeded"),
    contract: { trigger: "Approved/due ai_execution_jobs worker queue", permission: "AI Control Center + action approval/permission policy", inputs: "Validated queued action payload", outputs: "Executed, failed or canceled durable job", audit: "ai_execution_jobs + audit events", retry: "Durable worker retry with terminal state and stuck-job detection", cost: "Per underlying action in ai_usage_events" },
  },
  {
    key: "voice_ai", label: "AI Receptionist", cadence: "Inbound call, event-driven", failureKey: "voice_ai", configured: (salon) => salon.voice_ai_enabled === true, evidence: (input, salonId) => input.voice.filter((row) => row.salon_id === salonId && hasCompleteVoiceTelemetry(row)),
    contract: { trigger: "Inbound Twilio call routed to the salon", permission: "voice_ai_enabled + salon phone configuration", inputs: "Caller audio, salon services, hours and booking tools", outputs: "Spoken response and guarded booking/tool action", audit: "voice_ai_sessions with model, schemaVersion 1 usage and cost", retry: "Session TTL, stale-session detection and provider-safe fallback", cost: "voice_ai_sessions.estimated_cost_usd + realtime_usage" },
  },
];

function evidenceAt(row: EvidenceRow): string | null {
  // An outcome can resolve weeks after the original action. Prefer the
  // resolution time so a fresh conversion is not displayed as stale evidence.
  return row.outcome_at ?? row.created_at ?? row.started_at ?? null;
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
        ? "An active operational failure signal exists for this agent or worker."
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
      contract: agent.contract,
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
    const staleVoiceBefore = new Date(
      Date.now() - (SESSION_TTL_SECONDS + 5 * 60) * 1_000,
    ).toISOString();
    const [salons, actions, usage, voice, policies, jobs, managerRuns, workerStates, activeAgentExceptions, staleVoiceSessions] = await Promise.all([
      db.from("salons").select("id, name, slug, feature_flags, voice_ai_enabled, google_place_id, yelp_business_id").is("archived_at", null).order("name"),
      db.from("ai_actions_log" as never)
        .select("salon_id, agent, action_type, created_at, outcome_at" as never)
        .or(`created_at.gte.${since},outcome_at.gte.${since}` as never)
        .limit(limit),
      db.from("ai_usage_events" as never).select("salon_id, feature, status, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("voice_ai_sessions" as never).select("salon_id, status, model, realtime_usage, estimated_cost_usd, started_at" as never).gte("started_at" as never, since).limit(limit),
      db.from("ai_policy_decisions" as never).select("salon_id, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("ai_execution_jobs" as never).select("salon_id, status, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("ai_worker_runs" as never).select("started_at, status, summary" as never).eq("worker_name" as never, "ai_manager").order("started_at" as never, { ascending: false }).limit(1),
      db.from("ai_execution_worker_state" as never).select("worker_name, status" as never).in("worker_name" as never, ["ai_execution", "reminders"]),
      db.from("watchdog_alerts" as never)
        .select("salon_id, source_ref, status" as never)
        .eq("source_type" as never, "ai_manager")
        .eq("kind" as never, "manager_agent_failure")
        .in("status" as never, ["open", "acknowledged"] as never),
      db.from("voice_ai_sessions" as never)
        .select("salon_id, status, started_at" as never)
        .eq("status" as never, "active")
        .lt("started_at" as never, staleVoiceBefore),
    ]);
    const results = [salons, actions, usage, voice, policies, jobs, managerRuns, workerStates, activeAgentExceptions, staleVoiceSessions];
    if (results.some((result) => result.error)) {
      console.error("[superadmin/agent-certification] query unavailable", results.map((result) => result.error?.code ?? null));
      return { ok: false, error: "unavailable" };
    }
    const latestRun = (managerRuns.data?.[0] ?? null) as { started_at?: string } | null;
    const salonSlugById = new Map(
      ((salons.data ?? []) as SalonRow[]).map((salon) => [salon.id, salon.slug]),
    );
    const failedAgents = activeAgentFailureKeys(
      (activeAgentExceptions.data ?? []) as unknown as ActiveAgentExceptionRow[],
      salonSlugById,
    );
    for (const salonId of staleVoiceSessionSalonIds(
      (staleVoiceSessions.data ?? []) as unknown as EvidenceRow[],
    )) {
      const slug = salonSlugById.get(salonId);
      if (slug) failedAgents.add(`${slug}:voice_ai`);
    }
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
      truncated: [actions, usage, voice, policies, jobs]
        .some((result) => (result.data?.length ?? 0) === limit),
    } };
  } catch (error) {
    console.error("[superadmin/agent-certification] unavailable", error);
    return { ok: false, error: "unavailable" };
  }
}
