import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildAgentCertificationMatrix } from "@/shared/superadmin/agentCertificationActions";

const salon = {
  id: "s1",
  name: "Salon",
  slug: "salon",
  feature_flags: {
    ai_winback: true,
    ai_rebook: true,
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
  notifications: [],
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
});
