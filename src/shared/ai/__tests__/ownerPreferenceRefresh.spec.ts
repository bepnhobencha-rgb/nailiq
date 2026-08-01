import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const queryCalls: Array<[string, unknown]> = [];
let historyRows: Array<{ status: "approved" | "declined"; decided_at: string }> =
  [];
const setPreference = vi.fn();

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          queryCalls.push([column, value]);
          return chain;
        },
        in: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (
          resolve: (value: {
            data: typeof historyRows;
            error: null;
          }) => unknown,
        ) => Promise.resolve(resolve({ data: historyRows, error: null })),
      };
      return chain;
    },
  }),
}));

vi.mock("@/shared/ai/lessonMutations", () => ({
  setOwnerProposalPreference: (...args: unknown[]) => setPreference(...args),
}));

import { refreshOwnerProposalPreference } from "@/shared/ai/ownerPreference";

describe("refreshOwnerProposalPreference", () => {
  beforeEach(() => {
    queryCalls.length = 0;
    historyRows = [];
    setPreference.mockReset();
    setPreference.mockResolvedValue({
      lessonId: "lesson-1",
      changed: true,
      active: true,
    });
  });

  it("uses tenant, action and proposal-source boundaries", async () => {
    historyRows = [
      { status: "declined", decided_at: "2026-07-27T00:00:00Z" },
      { status: "approved", decided_at: "2026-07-26T00:00:00Z" },
      { status: "declined", decided_at: "2026-07-25T00:00:00Z" },
    ];

    const result = await refreshOwnerProposalPreference({
      salonId: "salon-1",
      actionType: "bulk_message",
      proposalSource: "weekly_strategist",
      now: new Date("2026-07-27T17:00:00Z"),
    });

    expect(queryCalls).toContainEqual(["salon_id", "salon-1"]);
    expect(queryCalls).toContainEqual(["action_type", "bulk_message"]);
    expect(queryCalls).toContainEqual([
      "payload->>proposal_source",
      "weekly_strategist",
    ]);
    expect(setPreference).toHaveBeenCalledWith(
      expect.objectContaining({
        salonId: "salon-1",
        actionType: "bulk_message",
        proposalSource: "weekly_strategist",
        active: true,
        suppressUntil: "2026-08-24T17:00:00.000Z",
      }),
    );
    expect(result).toMatchObject({ changed: true, active: true, action: "activate" });
  });

  it("does not mutate a lesson inside the hysteresis band", async () => {
    historyRows = [
      { status: "approved", decided_at: "2026-07-27T00:00:00Z" },
      { status: "declined", decided_at: "2026-07-26T00:00:00Z" },
    ];

    const result = await refreshOwnerProposalPreference({
      salonId: "salon-1",
      actionType: "bulk_message",
      proposalSource: "weekly_strategist",
    });

    expect(setPreference).not.toHaveBeenCalled();
    expect(result).toEqual({
      lessonId: null,
      changed: false,
      active: false,
      action: "hold",
    });
  });
});
