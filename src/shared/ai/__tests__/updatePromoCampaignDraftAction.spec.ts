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

import { updatePromoCampaignDraftAction } from "@/shared/ai/updatePromoCampaignDraftAction";

const approvalId = "11111111-1111-4111-8111-111111111111";

describe("updatePromoCampaignDraftAction", () => {
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
          proposal_source: "weekly_strategist",
          campaign_mode: "dashboard_draft_only",
        },
      },
      error: null,
    });
    mocks.rpc.mockResolvedValue({ data: "updated", error: null });
  });

  it("persists a non-numeric owner edit through the actor-checked RPC", async () => {
    await expect(
      updatePromoCampaignDraftAction({
        slug: "promo-qa",
        approvalId,
        draftMessage: "Discover an owner-confirmed salon offer before booking.",
        offerFactsConfirmed: false,
      }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "update_promo_campaign_draft_as_actor",
      expect.objectContaining({
        p_approval_id: approvalId,
        p_actor_user_id: "33333333-3333-4333-8333-333333333333",
        p_offer_facts_confirmed: false,
      }),
    );
  });

  it("rejects numeric offer facts unless the owner explicitly confirms them", async () => {
    await expect(
      updatePromoCampaignDraftAction({
        slug: "promo-qa",
        approvalId,
        draftMessage: "Owner confirmed: take 15 percent off a selected service.",
        offerFactsConfirmed: false,
      }),
    ).resolves.toEqual({ ok: false, error: "invalid_draft" });
    expect(mocks.rpc).not.toHaveBeenCalled();

    await expect(
      updatePromoCampaignDraftAction({
        slug: "promo-qa",
        approvalId,
        draftMessage: "Owner confirmed: take 15 percent off a selected service.",
        offerFactsConfirmed: true,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects a non-owner before any service-role read", async () => {
    mocks.getDashboardWriteClient.mockResolvedValue({
      salon: { id: "22222222-2222-4222-8222-222222222222" },
      role: "receptionist",
      userId: "33333333-3333-4333-8333-333333333333",
    });
    await expect(
      updatePromoCampaignDraftAction({
        slug: "promo-qa",
        approvalId,
        draftMessage: "Discover an owner-confirmed salon offer before booking.",
        offerFactsConfirmed: false,
      }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });
});
