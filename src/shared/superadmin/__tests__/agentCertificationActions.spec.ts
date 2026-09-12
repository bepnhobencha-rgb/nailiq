import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("server-only", () => ({}));

import {
  activeAgentFailureKeys,
  buildAgentCertificationMatrix,
  latestTrackedWorkerFailed,
  staleVoiceSessionSalonIds,
} from "@/shared/superadmin/agentCertificationActions";

const salon = {
  id: "s1",
  name: "Salon",
  slug: "salon",
  feature_flags: {
    ai_winback: true,
    ai_rebook: true,
    ai_smart_reminders: true,
    ai_vip_care: false,
  },
  voice_ai_enabled: false,
  google_place_id: null,
  yelp_business_id: null,
  archived_at: null,
  superadmin_locked_at: null,
  subscription_status: "active",
};

const emptyEvidence = {
  actions: [],
  usage: [],
  voice: [],
  policies: [],
  jobs: [],
};

const TEST_NOW = new Date("2026-08-03T12:00:00Z");

function buildMatrix(
  input: Omit<Parameters<typeof buildAgentCertificationMatrix>[0], "now">,
) {
  return buildAgentCertificationMatrix({ ...input, now: TEST_NOW });
}

describe("Agent Certification Matrix", () => {
  it("includes the 20 existing agents plus five previously missing AI surfaces", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "daily_report",
          action_type: "sent_report",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows).toHaveLength(25);
    expect(rows.map((row) => row.agent)).toEqual(expect.arrayContaining([
      "minh_self_learn",
      "minh_late_decline",
      "sms_receptionist",
      "booking_chat",
      "admin_copilot",
    ]));
    expect(rows.find((row) => row.agent === "daily_report")).toMatchObject({
      agentLabel: "Daily Report",
      status: "certified",
      evidenceCount: 1,
    });
  });

  it("publishes every mandatory typed contract field for every agent", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: emptyEvidence,
      failedAgents: new Set(),
    });

    for (const row of rows) {
      expect(Object.keys(row.contract).sort()).toEqual([
        "auditContract",
        "costPolicy",
        "effectLevel",
        "inputs",
        "outputs",
        "permissionContract",
        "retryPolicy",
        "runtimeEvidencePredicate",
        "trigger",
      ]);
      expect(row.contract.trigger.summary.length).toBeGreaterThan(0);
      expect(row.contract.trigger.freshnessHours).toBeGreaterThan(0);
      expect(row.contract.permissionContract.length).toBeGreaterThan(0);
      expect(row.contract.inputs.length).toBeGreaterThan(0);
      expect(row.contract.outputs.length).toBeGreaterThan(0);
      expect(row.contract.auditContract.length).toBeGreaterThan(0);
      expect(row.contract.retryPolicy.length).toBeGreaterThan(0);
      expect(row.contract.costPolicy.summary.length).toBeGreaterThan(0);
      expect(row.contract.runtimeEvidencePredicate.summary.length).toBeGreaterThan(0);
    }
    expect(rows.find((row) => row.agent === "voice_ai")?.contract)
      .toMatchObject({
        permissionContract: expect.arrayContaining([
          expect.stringContaining("voice_ai_enabled"),
        ]),
        auditContract: expect.arrayContaining([
          expect.stringContaining("voice_ai_session"),
        ]),
        runtimeEvidencePredicate: { category: "session_telemetry" },
      });
  });

  it("marks Daily Report unconfigured when Unified Digest replaces it", () => {
    const rows = buildMatrix({
      salons: [{
        ...salon,
        feature_flags: { ...salon.feature_flags, ai_unified_digest: true },
      }],
      evidence: emptyEvidence,
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "daily_report")?.status)
      .toBe("not_configured");
  });

  it("distinguishes certified, not-enough-evidence, and unconfigured agents", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{ salon_id: "s1", agent: "winback", action_type: "sent_sms", created_at: "2026-08-03T00:00:00Z" }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "winback")).toMatchObject({
      status: "certified",
      evidenceCount: 1,
    });
    expect(rows.find((row) => row.agent === "rebook")?.status).toBe("not_enough_evidence");
    expect(rows.find((row) => row.agent === "vip_care")?.status).toBe("not_configured");
  });

  it("gives the latest manager failure precedence over old evidence", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{ salon_id: "s1", agent: "winback", action_type: "sent_sms", created_at: "2026-08-03T00:00:00Z" }],
      },
      failedAgents: new Set(["salon:winback"]),
    });

    expect(rows.find((row) => row.agent === "winback")?.status).toBe("failed");
  });

  it("does not report a failure for an agent that is not configured", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: emptyEvidence,
      failedAgents: new Set(["salon:vip_care"]),
    });

    expect(rows.find((row) => row.agent === "vip_care")?.status).toBe("not_configured");
  });

  it("requires explicit permission before Google Review Responder is configured", () => {
    const withoutPermission = buildMatrix({
      salons: [{ ...salon, google_place_id: "place-1" }],
      evidence: emptyEvidence,
      failedAgents: new Set(),
    });
    const withPermission = buildMatrix({
      salons: [{
        ...salon,
        google_place_id: "place-1",
        feature_flags: { ...salon.feature_flags, ai_google_reply: true },
      }],
      evidence: emptyEvidence,
      failedAgents: new Set(),
    });

    expect(withoutPermission.find((row) => row.agent === "review_responder")?.status)
      .toBe("not_configured");
    expect(withPermission.find((row) => row.agent === "review_responder")?.status)
      .toBe("not_enough_evidence");
  });

  it("uses a fresh outcome timestamp for Outcome Tracker evidence", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "winback",
          created_at: "2026-06-17T00:00:00Z",
          outcome_at: "2026-08-02T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "outcome_tracker")).toMatchObject({
      status: "certified",
      evidenceCount: 1,
      lastEvidenceAt: "2026-08-02T00:00:00Z",
    });
  });

  it("does not make a stale customer delivery fresh from a recent outcome", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "winback",
          action_type: "sent_sms",
          created_at: "2026-07-01T00:00:00Z",
          outcome_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "winback")).toMatchObject({
      status: "not_enough_evidence",
      freshEvidenceCount: 0,
      lastEvidenceAt: "2026-07-01T00:00:00Z",
    });
    expect(rows.find((row) => row.agent === "outcome_tracker")?.status)
      .toBe("certified");
  });

  it("excludes staff overrides from No-show AI certification", () => {
    const configuredSalon = {
      ...salon,
      feature_flags: {
        ...salon.feature_flags,
        ai_noshow_policy_shadow: true,
      },
    };
    const overrideOnly = buildMatrix({
      salons: [configuredSalon],
      evidence: {
        ...emptyEvidence,
        policies: [{
          salon_id: "s1",
          agent: "noshow_policy",
          mode: "override",
          applied: true,
          ai_confidence: null,
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });
    const modelDecision = buildMatrix({
      salons: [configuredSalon],
      evidence: {
        ...emptyEvidence,
        policies: [{
          salon_id: "s1",
          agent: "noshow_policy",
          mode: "live",
          applied: true,
          ai_confidence: "medium",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(overrideOnly.find((row) => row.agent === "noshow")?.status)
      .toBe("not_enough_evidence");
    expect(modelDecision.find((row) => row.agent === "noshow")?.status)
      .toBe("certified");
  });

  it("keeps shadow-only No-show analysis as not enough evidence of a live effect", () => {
    const rows = buildMatrix({
      salons: [{
        ...salon,
        feature_flags: {
          ...salon.feature_flags,
          ai_noshow_policy_shadow: true,
        },
      }],
      evidence: {
        ...emptyEvidence,
        policies: [{
          salon_id: "s1",
          agent: "noshow_policy",
          mode: "shadow",
          applied: false,
          ai_confidence: "medium",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "noshow")?.status)
      .toBe("not_enough_evidence");
  });

  it("does not certify Smart Reminders without a persisted booking/run correlation", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        usage: [{
          salon_id: "s1",
          feature: "smart_reminder",
          status: "succeeded",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "smart_reminders")).toMatchObject({
      status: "not_enough_evidence",
      evidenceCount: 0,
      contract: {
        runtimeEvidencePredicate: { category: "unavailable" },
      },
    });
  });

  it("does not certify Smart Reminders from model usage alone", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        usage: [{
          salon_id: "s1",
          feature: "smart_reminder",
          status: "succeeded",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "smart_reminders")?.status)
      .toBe("not_enough_evidence");
  });

  it("does not certify abandoned or incomplete AI Receptionist sessions", () => {
    const rows = buildMatrix({
      salons: [{ ...salon, voice_ai_enabled: true }],
      evidence: {
        ...emptyEvidence,
        voice: [{
          salon_id: "s1",
          status: "abandoned",
          model: "gpt-realtime-2.1",
          realtime_usage: { schemaVersion: 1 },
          estimated_cost_usd: 0.01,
          started_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "voice_ai")?.status).toBe(
      "not_enough_evidence",
    );
  });

  it("certifies AI Receptionist only with a completed telemetry artifact", () => {
    const rows = buildMatrix({
      salons: [{ ...salon, voice_ai_enabled: true }],
      evidence: {
        ...emptyEvidence,
        voice: [{
          salon_id: "s1",
          status: "completed",
          model: "gpt-realtime-2.1",
          realtime_usage: { schemaVersion: 1 },
          estimated_cost_usd: 0.01,
          started_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "voice_ai")).toMatchObject({
      status: "certified",
      evidenceCount: 1,
    });
  });

  it("does not certify usage-backed agents from failed model calls", () => {
    const rows = buildMatrix({
      salons: [{
        ...salon,
        feature_flags: { ...salon.feature_flags, ai_watchdog: true },
      }],
      evidence: {
        ...emptyEvidence,
        usage: [{
          salon_id: "s1",
          feature: "watchdog",
          status: "failed",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "watchdog")?.status).toBe(
      "not_enough_evidence",
    );
  });

  it("does not certify customer-outreach agents from skipped sends", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "winback",
          action_type: "skipped_no_channel",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "winback")?.status).toBe(
      "not_enough_evidence",
    );
  });

  it("does not certify an agent from a generic or draft-only action type", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "winback",
          action_type: "suggestion_pending",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "winback")).toMatchObject({
      status: "not_enough_evidence",
      evidenceCount: 0,
    });
  });

  it("downgrades eligible but stale evidence according to agent cadence", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "winback",
          action_type: "sent_email",
          created_at: "2026-07-28T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "winback")).toMatchObject({
      status: "not_enough_evidence",
      evidenceCount: 1,
      freshEvidenceCount: 0,
    });
  });

  it("certifies the self-learning loop only from tenant-scoped material evidence", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "minh_self_learn",
          action_type: "lesson_created",
          created_at: "2026-08-03T03:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "minh_self_learn")?.status)
      .toBe("certified");
  });

  it("does not apply a global self-learning summary to every salon", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: null,
          agent: "minh_self_learn",
          action_type: "daily_learn_summary",
          created_at: "2026-08-03T03:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "minh_self_learn")?.status)
      .toBe("not_enough_evidence");
  });

  it("does not configure self-learning for a locked or canceled tenant", () => {
    const rows = buildMatrix({
      salons: [{
        ...salon,
        superadmin_locked_at: "2026-08-03T00:00:00Z",
        subscription_status: "canceled",
      }],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "minh_self_learn",
          action_type: "lesson_created",
          created_at: "2026-08-03T03:00:00Z",
        }],
      },
      failedAgents: new Set(["salon:minh_self_learn"]),
    });

    expect(rows.find((row) => row.agent === "minh_self_learn")?.status)
      .toBe("not_configured");
  });

  it("certifies late-group-decline only when the audit confirms an SMS send", () => {
    const rows = buildMatrix({
      salons: [{
        ...salon,
        feature_flags: { ...salon.feature_flags, group_booking_enabled: true },
      }],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "minh_late_decline",
          action_type: "late_decline_handled",
          payload: { outcome: "sms_suggested:ok|sms_waitlist:none" },
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "minh_late_decline")?.status)
      .toBe("certified");
  });

  it("keeps SMS Receptionist unverified when only model-use evidence exists", () => {
    const rows = buildMatrix({
      salons: [{ ...salon, voice_ai_enabled: true }],
      evidence: {
        ...emptyEvidence,
        usage: [{
          salon_id: "s1",
          feature: "sms_receptionist",
          status: "succeeded",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "sms_receptionist")).toMatchObject({
      status: "not_enough_evidence",
      evidenceCount: 0,
      contract: {
        runtimeEvidencePredicate: { category: "unavailable" },
      },
    });
  });

  it("uses successful model execution for Public Booking Chat and Admin Copilot", () => {
    const rows = buildMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        usage: [
          { salon_id: "s1", feature: "booking_chat", status: "succeeded", created_at: "2026-08-03T00:00:00Z" },
          { salon_id: "s1", feature: "admin_copilot", status: "succeeded", created_at: "2026-08-03T00:01:00Z" },
        ],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "booking_chat")?.status)
      .toBe("certified");
    expect(rows.find((row) => row.agent === "admin_copilot")?.status)
      .toBe("certified");
  });

  it("does not certify AI Execution from canceled or failed jobs", () => {
    const rows = buildMatrix({
      salons: [{
        ...salon,
        feature_flags: {
          ...salon.feature_flags,
          ai_control_center_enabled: true,
        },
      }],
      evidence: {
        ...emptyEvidence,
        jobs: [{
          salon_id: "s1",
          status: "failed",
          created_at: "2026-08-03T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "ai_execution")?.status).toBe(
      "not_enough_evidence",
    );
  });

  it("detects voice sessions that outlive the realtime session TTL", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    const staleSalons = staleVoiceSessionSalonIds([
      {
        salon_id: "stale",
        status: "active",
        started_at: "2026-08-08T11:20:00Z",
      },
      {
        salon_id: "recent",
        status: "active",
        started_at: "2026-08-08T11:50:00Z",
      },
      {
        salon_id: "ended",
        status: "abandoned",
        started_at: "2026-08-08T10:00:00Z",
      },
    ], now);

    expect([...staleSalons]).toEqual(["stale"]);
  });

  it("maps durable Manager exceptions by the schema-backed source reference", () => {
    const failures = activeAgentFailureKeys(
      [
        { salon_id: "s1", source_ref: "watchdog", status: "open" },
        { salon_id: "s1", source_ref: "digest", status: "resolved" },
        { salon_id: "unknown", source_ref: "winback", status: "open" },
      ],
      new Map([["s1", "alpha-salon"]]),
    );

    expect([...failures]).toEqual(["alpha-salon:watchdog"]);
  });

  it("uses the latest tracked self-learning run as failure precedence", () => {
    expect(latestTrackedWorkerFailed([{ status: "failed" }, { status: "succeeded" }]))
      .toBe(true);
    expect(latestTrackedWorkerFailed([{ status: "succeeded" }, { status: "failed" }]))
      .toBe(false);
    expect(latestTrackedWorkerFailed([])).toBe(false);
  });

  it("queries the durable exception column that exists in the production schema", () => {
    const actionSource = readFileSync(
      resolve(process.cwd(), "src/shared/superadmin/agentCertificationActions.ts"),
      "utf8",
    );
    const schemaSource = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260728112951_add_ai_operational_exception_signals.sql",
      ),
      "utf8",
    );

    expect(schemaSource).toContain("add column if not exists source_ref text");
    expect(actionSource).toContain('.select("salon_id, source_ref, status" as never)');
    expect(actionSource).not.toContain("alert_type");
  });

  it("loads the proof fields required to distinguish No-show AI from staff overrides", () => {
    const actionSource = readFileSync(
      resolve(process.cwd(), "src/shared/superadmin/agentCertificationActions.ts"),
      "utf8",
    );
    const pageSource = readFileSync(
      resolve(
        process.cwd(),
        "src/app/superadmin/(shell)/ai/performance/page.tsx",
      ),
      "utf8",
    );

    expect(actionSource).toContain(
      '.select("salon_id, agent, mode, applied, ai_confidence, created_at" as never)',
    );
    expect(pageSource).toContain("<caption className=\"sr-only\">");
    expect(pageSource).toContain("for {salon.name}");
  });
});
