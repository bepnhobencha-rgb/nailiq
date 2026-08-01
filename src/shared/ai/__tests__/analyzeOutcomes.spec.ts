import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ agent: string; outcome: string }>,
  insert: vi.fn(),
  setAdaptation: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/ai/lessonMutations", () => ({
  setOutcomeAdaptation: mocks.setAdaptation,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      const next = () => chain;
      chain.select = next;
      chain.eq = next;
      chain.neq = next;
      chain.not = next;
      chain.gte = next;
      chain.insert = mocks.insert;
      chain.then = (
        resolve: (value: {
          data: typeof mocks.rows;
          error: null;
        }) => void,
      ) => {
        resolve({ data: mocks.rows, error: null });
        return Promise.resolve();
      };
      return chain;
    },
  }),
}));

import { analyzeAgentOutcomes } from "@/shared/ai/analyzeOutcomes";

describe("analyzeAgentOutcomes", () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.insert.mockReset().mockResolvedValue({ error: null });
    mocks.setAdaptation.mockReset();
  });

  it("activates one idempotent cap and audits a low-conversion agent", async () => {
    mocks.rows = Array.from({ length: 10 }, () => ({
      agent: "winback",
      outcome: "no_conversion",
    }));
    mocks.setAdaptation.mockResolvedValue({
      lessonId: "lesson-1",
      changed: true,
      active: true,
    });

    const result = await analyzeAgentOutcomes("salon-1");

    expect(mocks.setAdaptation).toHaveBeenCalledWith({
      salonId: "salon-1",
      agent: "winback",
      active: true,
      capMultiplier: 0.5,
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        salon_id: "salon-1",
        action_type: "outcome_adaptation_activated",
        target_id: "lesson-1",
      }),
    );
    expect(result.adaptationsActivated).toBe(1);
    expect(result.lessonsAdjusted).toBe(1);
  });

  it("recovers the learned cap after sustained conversion improvement", async () => {
    mocks.rows = [
      ...Array.from({ length: 2 }, () => ({
        agent: "rebook",
        outcome: "converted",
      })),
      ...Array.from({ length: 8 }, () => ({
        agent: "rebook",
        outcome: "no_conversion",
      })),
    ];
    mocks.setAdaptation.mockResolvedValue({
      lessonId: "lesson-2",
      changed: true,
      active: false,
    });

    const result = await analyzeAgentOutcomes("salon-1");

    expect(mocks.setAdaptation).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "rebook", active: false }),
    );
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: "outcome_adaptation_recovered",
      }),
    );
    expect(result.adaptationsRecovered).toBe(1);
  });

  it("does not duplicate audit events when the lesson state is unchanged", async () => {
    mocks.rows = Array.from({ length: 10 }, () => ({
      agent: "vip_care",
      outcome: "no_conversion",
    }));
    mocks.setAdaptation.mockResolvedValue({
      lessonId: "lesson-3",
      changed: false,
      active: true,
    });

    const result = await analyzeAgentOutcomes("salon-1");

    expect(mocks.setAdaptation).toHaveBeenCalledOnce();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(result.lessonsAdjusted).toBe(0);
  });

  it("never adapts unapproved agent types", async () => {
    mocks.rows = Array.from({ length: 20 }, () => ({
      agent: "strategist",
      outcome: "no_conversion",
    }));

    await analyzeAgentOutcomes("salon-1");

    expect(mocks.setAdaptation).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
