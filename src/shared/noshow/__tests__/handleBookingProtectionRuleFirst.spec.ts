import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { ensureNoShowCardRequirement, runNoShowPolicyAgent } = vi.hoisted(() => ({
  ensureNoShowCardRequirement: vi.fn(),
  runNoShowPolicyAgent: vi.fn(),
}));

vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              id: "11111111-1111-4111-8111-111111111111",
              ai_profile: null,
              feature_flags: {
                ai_noshow_policy_live: true,
                ai_rule_first_optimization: true,
              },
            },
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/shared/noshow/agentNoShowPolicy", () => ({
  runNoShowPolicyAgent,
}));

vi.mock("@/shared/noshow/ensureNoShowCardRequirement", () => ({
  ensureNoShowCardRequirement,
}));

import { handleBookingProtection } from "@/shared/noshow/handleBookingProtection";

describe("handleBookingProtection rule-first fallback", () => {
  beforeEach(() => {
    runNoShowPolicyAgent.mockReset();
    ensureNoShowCardRequirement.mockReset();
    ensureNoShowCardRequirement.mockResolvedValue(undefined);
  });

  it("keeps deterministic protection when a live AI call is skipped", async () => {
    runNoShowPolicyAgent.mockResolvedValue(null);

    await handleBookingProtection(
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      "online",
    );

    expect(ensureNoShowCardRequirement).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("does not overwrite a guarded live AI decision", async () => {
    runNoShowPolicyAgent.mockResolvedValue({ cardRequired: false });

    await handleBookingProtection(
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      "online",
    );

    expect(ensureNoShowCardRequirement).not.toHaveBeenCalled();
  });
});
