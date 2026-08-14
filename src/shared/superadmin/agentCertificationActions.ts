import "server-only";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { SESSION_TTL_SECONDS } from "@/shared/voiceai/config";
import {
  AGENT_CERTIFICATION_REGISTRY,
  type AgentCertificationDefinition,
  type AgentCostPolicy,
  type AgentEffectLevel,
  type AgentTriggerContract,
  type CertificationEvidenceInput,
  type CertificationEvidenceRow,
  type RuntimeEvidenceCategory,
  type SalonCertificationContext,
} from "@/shared/superadmin/agentCertificationRegistry";

export type CertificationStatus =
  | "certified"
  | "not_enough_evidence"
  | "not_configured"
  | "failed";

type ActiveAgentExceptionRow = {
  salon_id: string;
  source_ref: string | null;
  status: string;
};

export type AgentCertificationContractView = {
  trigger: AgentTriggerContract;
  permissionContract: string[];
  inputs: string[];
  outputs: string[];
  effectLevel: AgentEffectLevel;
  auditContract: string[];
  retryPolicy: string[];
  costPolicy: AgentCostPolicy;
  runtimeEvidencePredicate: {
    category: RuntimeEvidenceCategory;
    summary: string;
  };
};

export type AgentCertificationRow = {
  salonId: string;
  salonName: string;
  slug: string;
  agent: string;
  agentLabel: string;
  cadence: string;
  freshnessHours: number;
  status: CertificationStatus;
  evidenceCount: number;
  freshEvidenceCount: number;
  lastEvidenceAt: string | null;
  reason: string;
  contract: AgentCertificationContractView;
};

export type AgentCertificationData = {
  windowDays: number;
  generatedAt: string;
  latestManagerRunAt: string | null;
  matrix: AgentCertificationRow[];
  counts: Record<CertificationStatus, number>;
  truncated: boolean;
};

export function staleVoiceSessionSalonIds(
  rows: CertificationEvidenceRow[],
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
      .map((row) => row.salon_id)
      .filter((salonId): salonId is string => Boolean(salonId)),
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

export function latestTrackedWorkerFailed(
  rows: Array<{ status?: string | null }>,
): boolean {
  return rows[0]?.status === "failed";
}

function evidenceAt(
  row: CertificationEvidenceRow,
  agent: AgentCertificationDefinition,
): string | null {
  // Evidence timestamps are contract-specific. A later conversion outcome
  // must never make an old customer delivery look newly executed.
  if (agent.runtimeEvidencePredicate.category === "outcome_attribution") {
    return row.outcome_at ?? null;
  }
  if (
    agent.runtimeEvidencePredicate.category === "session_telemetry" ||
    agent.runtimeEvidencePredicate.category === "worker_run"
  ) {
    return row.started_at ?? null;
  }
  return row.created_at ?? row.updated_at ?? null;
}

function contractView(
  agent: AgentCertificationDefinition,
): AgentCertificationContractView {
  return {
    trigger: { ...agent.trigger },
    permissionContract: [...agent.permissionContract],
    inputs: [...agent.inputs],
    outputs: [...agent.outputs],
    effectLevel: agent.effectLevel,
    auditContract: [...agent.auditContract],
    retryPolicy: [...agent.retryPolicy],
    costPolicy: {
      ...agent.costPolicy,
      ledgerFeatures: [...agent.costPolicy.ledgerFeatures],
    },
    runtimeEvidencePredicate: {
      category: agent.runtimeEvidencePredicate.category,
      summary: agent.runtimeEvidencePredicate.summary,
    },
  };
}

export function buildAgentCertificationMatrix(input: {
  salons: SalonCertificationContext[];
  evidence: CertificationEvidenceInput;
  failedAgents: Set<string>;
  now?: Date;
}): AgentCertificationRow[] {
  const now = input.now ?? new Date();
  return input.salons.flatMap((salon) => AGENT_CERTIFICATION_REGISTRY.map((agent) => {
    const configured = agent.configured(salon);
    const evidence = configured
      ? agent.runtimeEvidencePredicate.evaluate(input.evidence, salon)
      : [];
    const freshnessCutoff = now.getTime() - agent.trigger.freshnessHours * 60 * 60 * 1_000;
    const freshEvidence = evidence.filter((row) => {
      const at = evidenceAt(row, agent);
      const atMs = Date.parse(at ?? "");
      return Number.isFinite(atMs) &&
        atMs >= freshnessCutoff &&
        atMs <= now.getTime() + 5 * 60 * 1_000;
    });
    const latest = evidence
      .map((row) => evidenceAt(row, agent))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    const failed = input.failedAgents.has(`${salon.slug}:${agent.failureKey}`);
    const status: CertificationStatus = !configured
      ? "not_configured"
      : failed
        ? "failed"
        : freshEvidence.length > 0
          ? "certified"
          : "not_enough_evidence";
    const reason = status === "not_configured"
      ? "Required feature flag or provider configuration is missing."
      : status === "failed"
        ? "An active operational failure signal exists for this agent or worker."
        : status === "certified"
          ? `Fresh ${agent.runtimeEvidencePredicate.category.replaceAll("_", " ")} evidence satisfies this agent's contract.`
          : evidence.length > 0
            ? `Eligible evidence exists, but it is older than this cadence's ${agent.trigger.freshnessHours}-hour freshness limit.`
            : `Configured, but ${agent.runtimeEvidencePredicate.summary.toLowerCase()} was not found.`;
    return {
      salonId: salon.id,
      salonName: salon.name,
      slug: salon.slug,
      agent: agent.key,
      agentLabel: agent.label,
      cadence: agent.trigger.summary,
      freshnessHours: agent.trigger.freshnessHours,
      status,
      evidenceCount: evidence.length,
      freshEvidenceCount: freshEvidence.length,
      lastEvidenceAt: latest,
      reason,
      contract: contractView(agent),
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
    const [salons, actions, usage, voice, policies, jobs, managerRuns, minhRuns, workerStates, activeAgentExceptions, staleVoiceSessions] = await Promise.all([
      db.from("salons").select("id, name, slug, feature_flags, voice_ai_enabled, google_place_id, yelp_business_id, archived_at, superadmin_locked_at, subscription_status, subscription_plan, plan_override").is("archived_at", null).order("name"),
      db.from("ai_actions_log" as never)
        .select("salon_id, agent, action_type, created_at, outcome_at, payload" as never)
        .or(`created_at.gte.${since},outcome_at.gte.${since}` as never)
        .limit(limit),
      db.from("ai_usage_events" as never).select("salon_id, feature, status, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("voice_ai_sessions" as never).select("salon_id, status, model, realtime_usage, estimated_cost_usd, started_at" as never).gte("started_at" as never, since).limit(limit),
      db.from("ai_policy_decisions" as never).select("salon_id, agent, mode, applied, ai_confidence, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("ai_execution_jobs" as never).select("salon_id, status, created_at" as never).gte("created_at" as never, since).limit(limit),
      db.from("ai_worker_runs" as never).select("started_at, status, summary" as never).eq("worker_name" as never, "ai_manager").order("started_at" as never, { ascending: false }).limit(1),
      db.from("ai_worker_runs" as never).select("started_at, status" as never).eq("worker_name" as never, "minh_learn").order("started_at" as never, { ascending: false }).limit(1),
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
    const results = [salons, actions, usage, voice, policies, jobs, managerRuns, minhRuns, workerStates, activeAgentExceptions, staleVoiceSessions];
    if (results.some((result) => result.error)) {
      console.error("[superadmin/agent-certification] query unavailable", results.map((result) => result.error?.code ?? null));
      return { ok: false, error: "unavailable" };
    }
    const latestRun = (managerRuns.data?.[0] ?? null) as { started_at?: string } | null;
    const salonSlugById = new Map(
      ((salons.data ?? []) as SalonCertificationContext[]).map((salon) => [salon.id, salon.slug]),
    );
    const failedAgents = activeAgentFailureKeys(
      (activeAgentExceptions.data ?? []) as unknown as ActiveAgentExceptionRow[],
      salonSlugById,
    );
    for (const salonId of staleVoiceSessionSalonIds(
      (staleVoiceSessions.data ?? []) as unknown as CertificationEvidenceRow[],
    )) {
      const slug = salonSlugById.get(salonId);
      if (slug) failedAgents.add(`${slug}:voice_ai`);
    }
    const failedWorkers = new Set(
      ((workerStates.data ?? []) as unknown as Array<{ worker_name: string; status: string }>)
        .filter((row) => row.status === "failed")
        .map((row) => row.worker_name),
    );
    for (const salon of (salons.data ?? []) as SalonCertificationContext[]) {
      if (failedWorkers.has("ai_execution")) failedAgents.add(`${salon.slug}:ai_execution`);
      if (failedWorkers.has("reminders")) failedAgents.add(`${salon.slug}:smart_reminders`);
      if (latestTrackedWorkerFailed(
        (minhRuns.data ?? []) as Array<{ status?: string | null }>,
      )) {
        failedAgents.add(`${salon.slug}:minh_self_learn`);
      }
    }
    const matrix = buildAgentCertificationMatrix({
      salons: (salons.data ?? []) as SalonCertificationContext[],
      evidence: {
        actions: (actions.data ?? []) as unknown as CertificationEvidenceRow[],
        usage: (usage.data ?? []) as unknown as CertificationEvidenceRow[],
        voice: (voice.data ?? []) as unknown as CertificationEvidenceRow[],
        policies: (policies.data ?? []) as unknown as CertificationEvidenceRow[],
        jobs: (jobs.data ?? []) as unknown as CertificationEvidenceRow[],
      },
      failedAgents,
      now: new Date(generatedAt),
    });
    const counts: Record<CertificationStatus, number> = {
      certified: 0,
      not_enough_evidence: 0,
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
