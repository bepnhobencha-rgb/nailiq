import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDashboardWriteClient: vi.fn(),
  maybeSingle: vi.fn(),
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/shared/dashboard/setupActions", () => ({
  getDashboardWriteClient: mocks.getDashboardWriteClient,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: mocks.maybeSingle }),
        }),
      }),
    }),
    rpc: mocks.rpc,
  }),
}));

import { updateReactivationCampaignDraftAction } from "@/shared/ai/updateReactivationCampaignDraftAction";

const approvalId = "11111111-1111-4111-8111-111111111111";

describe("updateReactivationCampaignDraftAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDashboardWriteClient.mockResolvedValue({
      salon: { id: "22222222-2222-4222-8222-222222222222" },
      role: "owner",
      userId: "33333333-3333-4333-8333-333333333333",
    });
    mocks.maybeSingle.mockResolvedValue({
      data: {
        salon_id: "22222222-2222-4222-8222-222222222222",
        action_type: "bulk_message",
        status: "pending",
        payload: {
          proposal_source: "reactivation_campaign",
          campaign_mode: "dashboard_draft_only",
        },
      },
      error: null,
    });
    mocks.rpc.mockResolvedValue({ data: "updated", error: null });
  });

  it("persists exact EN and VI owner edits through the actor-checked RPC", async () => {
    await expect(
      updateReactivationCampaignDraftAction({
        slug: "reactivation-qa",
        approvalId,
        messageEn: "We would love to welcome you back when the time is right.",
        messageVi: "Tiệm rất mong được đón bạn quay lại khi thời gian phù hợp.",
      }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "update_reactivation_campaign_draft_as_actor",
      expect.objectContaining({
        p_approval_id: approvalId,
        p_actor_user_id: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });

  it("rejects unsafe offer or contact content before the RPC", async () => {
    await expect(
      updateReactivationCampaignDraftAction({
        slug: "reactivation-qa",
        approvalId,
        messageEn: "Come back for a free service and 20 percent discount.",
        messageVi: "Tiệm rất mong được đón bạn quay lại khi thời gian phù hợp.",
      }),
    ).resolves.toEqual({ ok: false, error: "invalid_draft" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a non-owner before any service-role read", async () => {
    mocks.getDashboardWriteClient.mockResolvedValue({
      salon: { id: "22222222-2222-4222-8222-222222222222" },
      role: "receptionist",
      userId: "33333333-3333-4333-8333-333333333333",
    });
    await expect(
      updateReactivationCampaignDraftAction({
        slug: "reactivation-qa",
        approvalId,
        messageEn: "We would love to welcome you back when the time is right.",
        messageVi: "Tiệm rất mong được đón bạn quay lại khi thời gian phù hợp.",
      }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("fails closed when the approval is not from this salon or campaign", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      updateReactivationCampaignDraftAction({
        slug: "reactivation-qa",
        approvalId,
        messageEn: "We would love to welcome you back when the time is right.",
        messageVi: "Tiệm rất mong được đón bạn quay lại khi thời gian phù hợp.",
      }),
    ).resolves.toEqual({ ok: false, error: "not_found" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
