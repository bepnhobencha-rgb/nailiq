import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  activeAgentFailureKeys,
  buildAgentCertificationMatrix,
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
};

const emptyEvidence = {
  actions: [],
  usage: [],
  voice: [],
  policies: [],
  jobs: [],
};

describe("Agent Certification Matrix", () => {
  it("distinguishes certified, waiting, and unconfigured agents", () => {
    const rows = buildAgentCertificationMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{ salon_id: "s1", agent: "winback", created_at: "2026-08-03T00:00:00Z" }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "winback")).toMatchObject({
      status: "certified",
      evidenceCount: 1,
    });
    expect(rows.find((row) => row.agent === "rebook")?.status).toBe("waiting_data");
    expect(rows.find((row) => row.agent === "vip_care")?.status).toBe("not_configured");
  });

  it("gives the latest manager failure precedence over old evidence", () => {
    const rows = buildAgentCertificationMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{ salon_id: "s1", agent: "winback", created_at: "2026-08-03T00:00:00Z" }],
      },
      failedAgents: new Set(["salon:winback"]),
    });

    expect(rows.find((row) => row.agent === "winback")?.status).toBe("failed");
  });

  it("does not report a failure for an agent that is not configured", () => {
    const rows = buildAgentCertificationMatrix({
      salons: [salon],
      evidence: emptyEvidence,
      failedAgents: new Set(["salon:vip_care"]),
    });

    expect(rows.find((row) => row.agent === "vip_care")?.status).toBe("not_configured");
  });

  it("uses a fresh outcome timestamp for Outcome Tracker evidence", () => {
    const rows = buildAgentCertificationMatrix({
      salons: [salon],
      evidence: {
        ...emptyEvidence,
        actions: [{
          salon_id: "s1",
          agent: "winback",
          created_at: "2026-06-17T00:00:00Z",
          outcome_at: "2026-07-28T00:00:00Z",
        }],
      },
      failedAgents: new Set(),
    });

    expect(rows.find((row) => row.agent === "outcome_tracker")).toMatchObject({
      status: "certified",
      evidenceCount: 1,
      lastEvidenceAt: "2026-07-28T00:00:00Z",
    });
  });

  it("certifies Smart Reminders from a successful model-call artifact", () => {
    const rows = buildAgentCertificationMatrix({
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
      status: "certified",
      evidenceCount: 1,
    });
  });

  it("does not certify abandoned or incomplete AI Receptionist sessions", () => {
    const rows = buildAgentCertificationMatrix({
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
      "waiting_data",
    );
  });

  it("certifies AI Receptionist only with a completed telemetry artifact", () => {
    const rows = buildAgentCertificationMatrix({
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
    const rows = buildAgentCertificationMatrix({
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
      "waiting_data",
    );
  });

  it("does not certify customer-outreach agents from skipped sends", () => {
    const rows = buildAgentCertificationMatrix({
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
      "waiting_data",
    );
  });

  it("does not certify AI Execution from canceled or failed jobs", () => {
    const rows = buildAgentCertificationMatrix({
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
      "waiting_data",
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

  it("maps durable Manager exceptions by the agent alert type", () => {
    const failures = activeAgentFailureKeys(
      [
        { salon_id: "s1", alert_type: "watchdog", status: "open" },
        { salon_id: "s1", alert_type: "digest", status: "resolved" },
        { salon_id: "unknown", alert_type: "winback", status: "open" },
      ],
      new Map([["s1", "alpha-salon"]]),
    );

    expect([...failures]).toEqual(["alpha-salon:watchdog"]);
  });
});
