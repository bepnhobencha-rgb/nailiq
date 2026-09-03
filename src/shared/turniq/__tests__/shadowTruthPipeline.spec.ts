import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { captureTurnIqShadowCycle } from "@/shared/turniq/shadowTruthPipeline";

function terminalChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "lte", "order", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => result);
  return chain;
}

describe("TurnIQ shadow truth pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("waits quietly before the first policy effective business date", async () => {
    const salon = terminalChain({
      data: {
        id: "72000000-0000-4000-8000-000000000001",
        timezone: "America/Vancouver",
        resources_enabled: false,
      },
      error: null,
    });
    const policy = terminalChain({ data: null, error: null });
    const from = vi.fn((table: string) => {
      if (table === "salons") return salon;
      if (table === "turniq_policy_versions") return policy;
      throw new Error(`unexpected table: ${table}`);
    });
    mocks.createServiceRoleClient.mockReturnValue({ from });

    await expect(
      captureTurnIqShadowCycle({
        salonId: "72000000-0000-4000-8000-000000000001",
        businessDate: "2026-09-03",
        capturedAt: "2026-09-03T18:00:00.000Z",
        rolloutStage: "shadow",
      }),
    ).resolves.toEqual({
      status: "skipped",
      examined: 0,
      decisionsInserted: 0,
      comparisonsInserted: 0,
      unsupported: 0,
    });
    expect(from).toHaveBeenCalledTimes(2);
  });
});
