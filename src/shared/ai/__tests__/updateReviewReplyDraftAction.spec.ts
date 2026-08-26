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

import { updateReviewReplyDraftAction } from "@/shared/ai/updateReviewReplyDraftAction";

const approvalId = "11111111-1111-4111-8111-111111111111";

describe("updateReviewReplyDraftAction", () => {
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
        action_type: "review_reply_draft",
        status: "pending",
        payload: { language: "en" },
      },
      error: null,
    });
    mocks.rpc.mockResolvedValue({ data: "updated", error: null });
  });

  it("persists a safe same-language edit through the actor-checked RPC", async () => {
    await expect(
      updateReviewReplyDraftAction({
        slug: "review-reply-qa",
        approvalId,
        draftReply:
          "Thank you for sharing your experience. We appreciate your feedback.",
      }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "update_review_reply_draft_as_actor",
      expect.objectContaining({
        p_approval_id: approvalId,
        p_actor_user_id: "33333333-3333-4333-8333-333333333333",
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe contact/refund content before the privileged RPC", async () => {
    await expect(
      updateReviewReplyDraftAction({
        slug: "review-reply-qa",
        approvalId,
        draftReply: "We will refund you. Email owner@example.com.",
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
      updateReviewReplyDraftAction({
        slug: "review-reply-qa",
        approvalId,
        draftReply: "Thank you for sharing your experience with us.",
      }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
