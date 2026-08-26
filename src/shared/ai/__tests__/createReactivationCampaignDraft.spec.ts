import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/ai/agentPermissionFence", () => ({
  isAiAgentPermissionEnabled: mocks.permission,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import { createReactivationCampaignDraft } from "@/shared/ai/createReactivationCampaignDraft";

describe("createReactivationCampaignDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permission.mockResolvedValue(true);
    mocks.rpc.mockResolvedValue({
      data: [{ outcome: "created", approval_request_id: "approval-1" }],
      error: null,
    });
  });

  it("rechecks the owner flag and creates one deterministic PII-free draft", async () => {
    await expect(
      createReactivationCampaignDraft({
        salonId: "salon-1",
        salonName: "Hoa Hong Nails",
        kind: "winback",
        todayYmd: "2026-08-22",
      }),
    ).resolves.toBe("created");
    expect(mocks.permission).toHaveBeenCalledWith("salon-1", "ai_winback");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "create_reactivation_campaign_draft",
      expect.objectContaining({
        p_salon_id: "salon-1",
        p_campaign_kind: "winback",
        p_period_key: "2026-08-17",
        p_message_en: expect.stringContaining("Hoa Hong Nails"),
        p_message_vi: expect.stringContaining("Hoa Hong Nails"),
      }),
    );
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toMatch(
      /client_phone|client_email|recipient/iu,
    );
  });

  it("does nothing when the owner flag is disabled", async () => {
    mocks.permission.mockResolvedValue(false);
    await expect(
      createReactivationCampaignDraft({
        salonId: "salon-1",
        salonName: "Hoa Hong Nails",
        kind: "rebook",
        todayYmd: "2026-08-22",
      }),
    ).resolves.toBe("disabled");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("preserves atomic duplicate outcomes", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ outcome: "existing", approval_request_id: "approval-1" }],
      error: null,
    });
    await expect(
      createReactivationCampaignDraft({
        salonId: "salon-1",
        salonName: "Hoa Hong Nails",
        kind: "rebook",
        todayYmd: "2026-08-22",
      }),
    ).resolves.toBe("existing");
  });
});
