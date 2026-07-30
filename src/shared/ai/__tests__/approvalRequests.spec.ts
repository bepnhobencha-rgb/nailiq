import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  refreshOwnerProposalPreference: vi.fn(),
  approval: {
    id: "11111111-1111-4111-8111-111111111111",
    salon_id: "22222222-2222-4222-8222-222222222222",
    action_type: "prepare_reengagement_audience",
    summary: "Prepare an audience",
    payload: {} as Record<string, unknown>,
    urgency: "normal",
    status: "pending",
    approve_token: "approve-token",
    decline_token: "decline-token",
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
    from: (table: string) => {
      if (table === "approval_requests") {
        return {
          select: () => ({
            or: () => ({
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

      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));

import { processDecision } from "@/shared/ai/approvalRequests";

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
    mocks.refreshOwnerProposalPreference.mockReset();
    mocks.approval.payload = {};
  });

  it("returns the execution created by the atomic approval transition", async () => {
    mocks.rpc.mockResolvedValue({
      data: [transition("approved_queued")],
      error: null,
    });

    const result = await processDecision("approve-token", "approved");

    expect(mocks.rpc).toHaveBeenCalledWith("decide_ai_approval_request", {
      p_token: "approve-token",
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

    const result = await processDecision("approve-token", "approved");

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
      processDecision("approve-token", "approved"),
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
      processDecision("approve-token", "approved"),
    ).resolves.toMatchObject({
      ok: false,
      salonSlug: "tech-nails",
      alreadyDecided: false,
      expired: true,
    });
  });
});
