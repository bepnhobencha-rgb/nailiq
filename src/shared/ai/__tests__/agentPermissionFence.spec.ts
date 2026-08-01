import { beforeEach, describe, expect, it, vi } from "vitest";

const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from }),
}));

import { isAiAgentPermissionEnabled } from "@/shared/ai/agentPermissionFence";

describe("AI agent permission fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows only an explicitly enabled current flag", async () => {
    maybeSingle.mockResolvedValue({
      data: { feature_flags: { ai_winback: true, ai_rebook: false } },
      error: null,
    });

    await expect(
      isAiAgentPermissionEnabled("salon-1", "ai_winback"),
    ).resolves.toBe(true);
    await expect(
      isAiAgentPermissionEnabled("salon-1", "ai_rebook"),
    ).resolves.toBe(false);
    expect(from).toHaveBeenCalledWith("salons");
    expect(eq).toHaveBeenCalledWith("id", "salon-1");
  });

  it.each([
    { data: null, error: null },
    { data: { feature_flags: null }, error: null },
    { data: { feature_flags: {} }, error: null },
    { data: null, error: { message: "database unavailable" } },
  ])("fails closed when permission cannot be proven: %#", async (result) => {
    maybeSingle.mockResolvedValue(result);

    await expect(
      isAiAgentPermissionEnabled("salon-1", "ai_vip_care"),
    ).resolves.toBe(false);
  });
});
