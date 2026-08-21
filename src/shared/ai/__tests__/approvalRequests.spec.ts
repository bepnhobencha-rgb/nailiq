import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getUserById: vi.fn(),
  refreshOwnerProposalPreference: vi.fn(),
  memberships: [] as Array<{
    salon_id: string;
    user_id: string;
    role: string;
  }>,
  approval: {
    id: "11111111-1111-4111-8111-111111111111",
    salon_id: "22222222-2222-4222-8222-222222222222",
    action_type: "prepare_reengagement_audience",
    summary: "Prepare an audience",
    payload: {} as Record<string, unknown>,
    urgency: "normal",
    status: "pending",
    approve_token: "a".repeat(64),
    decline_token: "b".repeat(64),
    expires_at: "2099-01-01T00:00:00.000Z",
    notified_at: null,
    reminded_at: null,
    decided_by: null,
    decision_channel: null,
    decided_at: null,
    created_at: "2026-07-27T00:00:00.000Z",
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/shared/lib/resend", () => ({
  getResendClient: vi.fn(),
  getResendFrom: vi.fn(),
}));

vi.mock("@/shared/ai/ownerPreference", () => ({
  refreshOwnerProposalPreference: mocks.refreshOwnerProposalPreference,
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    rpc: mocks.rpc,
    auth: {
      admin: {
        getUserById: mocks.getUserById,
      },
    },
    from: (table: string) => {
      if (table === "approval_requests") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: mocks.approval }),
            }),
          }),
        };
      }

      if (table === "salons") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  name: "Tech Nails Salon",
                  slug: "tech-nails",
                  timezone: "America/Vancouver",
                  email: null,
                },
              }),
            }),
          }),
        };
      }

      if (table === "ai_actions_log") {
        return { insert: vi.fn().mockResolvedValue({ error: null }) };
      }

      if (table === "salon_members") {
        return {
          select: () => ({
            in: () => ({
              in: () => ({
                in: async () => ({
                  data: mocks.memberships,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));

import {
  processDecision,
  toApprovalDisplayRow,
  toApprovalDisplayRows,
  type ApprovalRow,
} from "@/shared/ai/approvalRequests";

function transition(
  outcome:
    | "approved_queued"
    | "approved_recovered"
    | "already_decided"
    | "expired",
) {
  return {
    outcome,
    approval_id: mocks.approval.id,
    salon_id: mocks.approval.salon_id,
    action_type: mocks.approval.action_type,
    decision_status: outcome === "expired" ? "expired" : "approved",
    execution_job_id:
      outcome === "expired" ? null : "33333333-3333-4333-8333-333333333333",
    execution_status: outcome === "expired" ? null : "queued",
    decided_at: outcome === "expired" ? null : "2026-07-27T01:00:00.000Z",
  };
}

describe("processDecision", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.getUserById.mockReset();
    mocks.refreshOwnerProposalPreference.mockReset();
    mocks.memberships = [];
    mocks.approval.payload = {};
  });

  it("returns the execution created by the atomic approval transition", async () => {
    mocks.rpc.mockResolvedValue({
      data: [transition("approved_queued")],
      error: null,
    });

    const result = await processDecision("a".repeat(64), "approved");

    expect(mocks.rpc).toHaveBeenCalledWith("decide_ai_approval_request", {
      p_token: "a".repeat(64),
      p_decision: "approved",
    });
    expect(result).toEqual({
      ok: true,
      salonSlug: "tech-nails",
      actionType: "prepare_reengagement_audience",
      alreadyDecided: false,
      expired: false,
      execution: {
        ok: true,
        jobId: "33333333-3333-4333-8333-333333333333",
        status: "queued",
        error: null,
      },
    });
  });

  it("returns a healed execution without relearning an old owner decision", async () => {
    mocks.approval.payload = { proposal_source: "strategist" };
    mocks.rpc.mockResolvedValue({
      data: [transition("approved_recovered")],
      error: null,
    });

    const result = await processDecision("a".repeat(64), "approved");

    expect(result.ok).toBe(true);
    expect(result.execution?.jobId).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(mocks.refreshOwnerProposalPreference).not.toHaveBeenCalled();
  });

  it("reports a repeated decision without pretending it was applied again", async () => {
    mocks.rpc.mockResolvedValue({
      data: [transition("already_decided")],
      error: null,
    });

    await expect(
      processDecision("a".repeat(64), "approved"),
    ).resolves.toMatchObject({
      ok: false,
      salonSlug: "tech-nails",
      alreadyDecided: true,
      expired: false,
    });
  });

  it("reports an approval that expired inside the locked transaction", async () => {
    mocks.rpc.mockResolvedValue({
      data: [transition("expired")],
      error: null,
    });

    await expect(
      processDecision("a".repeat(64), "approved"),
    ).resolves.toMatchObject({
      ok: false,
      salonSlug: "tech-nails",
      alreadyDecided: false,
      expired: true,
    });
  });
});

describe("approval display boundary", () => {
  it("rebuilds a minimal owner row without raw payload or internal fields", () => {
    const display = toApprovalDisplayRow({
      ...mocks.approval,
      payload: {
        reason: "Low future occupancy",
        recipients: [
          { phone: "+16045550001", provider_token: "secret-provider-token" },
          { phone: "+16045550002" },
        ],
        internal_prompt: "secret prompt",
      },
      decided_by: "44444444-4444-4444-8444-444444444444",
      decision_channel: "dashboard",
    } as ApprovalRow);

    expect(display).not.toHaveProperty("approve_token");
    expect(display).not.toHaveProperty("decline_token");
    expect(display).not.toHaveProperty("decided_by");
    expect(display).not.toHaveProperty("salon_id");
    expect(display).not.toHaveProperty("payload");
    expect(display).not.toHaveProperty("notified_at");
    expect(display).not.toHaveProperty("reminded_at");
    expect(JSON.stringify(display)).not.toContain("secret-provider-token");
    expect(JSON.stringify(display)).not.toContain("+16045550001");
    expect(JSON.stringify(display)).not.toContain("secret prompt");
    expect(display.intelligence.en).toMatchObject({
      reason: "Low future occupancy",
      impact: "This action will contact 2 customers.",
    });
    expect(display.decision_actor).toBeNull();
  });

  it("names a dashboard actor only after same-salon owner/admin revalidation", async () => {
    const actorId = "44444444-4444-4444-8444-444444444444";
    const decided = {
      ...mocks.approval,
      decided_by: actorId,
      decision_channel: "dashboard",
      status: "approved",
    } as ApprovalRow;
    mocks.memberships = [
      {
        salon_id: mocks.approval.salon_id,
        user_id: actorId,
        role: "owner",
      },
    ];
    mocks.getUserById.mockResolvedValue({
      data: {
        user: {
          email: "owner@example.com",
          phone: null,
          user_metadata: { full_name: "Salon Owner" },
        },
      },
      error: null,
    });

    await expect(toApprovalDisplayRows([decided])).resolves.toMatchObject([
      {
        decision_actor: {
          label: "Salon Owner",
          role: "owner",
        },
      },
    ]);
    expect(mocks.getUserById).toHaveBeenCalledWith(actorId);

    mocks.memberships = [
      {
        salon_id: "55555555-5555-4555-8555-555555555555",
        user_id: actorId,
        role: "owner",
      },
    ];
    mocks.getUserById.mockClear();

    await expect(toApprovalDisplayRows([decided])).resolves.toMatchObject([
      { decision_actor: null },
    ]);
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });
});
