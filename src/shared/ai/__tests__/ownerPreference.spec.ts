import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  decideOwnerProposalPreference,
  OWNER_PREFERENCE_COOLDOWN_DAYS,
} from "@/shared/ai/ownerPreference";
import {
  findProposalCooldown,
  type MinhLesson,
} from "@/shared/ai/lessons";

const NOW = new Date("2026-07-27T17:00:00.000Z");

function decision(
  status: "approved" | "declined",
  day: number,
): { status: "approved" | "declined"; decided_at: string } {
  return {
    status,
    decided_at: new Date(`2026-07-${String(day).padStart(2, "0")}T17:00:00Z`).toISOString(),
  };
}

function lesson(
  overrides: Partial<MinhLesson> = {},
): MinhLesson {
  return {
    id: "lesson-1",
    salonId: "salon-1",
    scope: "policy",
    condition: {
      action_type: "bulk_message",
      proposal_source: "weekly_strategist",
      suppress_until: "2026-08-24T17:00:00.000Z",
    },
    rule: "proposal_cooldown",
    source: "owner_preference:bulk_message:weekly_strategist",
    confidence: 0.8,
    ...overrides,
  };
}

describe("owner proposal preference", () => {
  it("requires repeated decline evidence before activating", () => {
    expect(
      decideOwnerProposalPreference(
        [decision("declined", 27), decision("declined", 26)],
        NOW,
      ),
    ).toEqual({ action: "hold", suppressUntil: null });

    const result = decideOwnerProposalPreference(
      [
        decision("declined", 27),
        decision("approved", 26),
        decision("declined", 25),
      ],
      NOW,
    );
    expect(result.action).toBe("activate");
    expect(result.suppressUntil).toBe(
      new Date(
        NOW.getTime() + OWNER_PREFERENCE_COOLDOWN_DAYS * 86_400_000,
      ).toISOString(),
    );
  });

  it("recovers only after two consecutive approvals", () => {
    expect(
      decideOwnerProposalPreference(
        [
          decision("approved", 27),
          decision("approved", 26),
          decision("declined", 25),
        ],
        NOW,
      ),
    ).toEqual({ action: "recover", suppressUntil: null });

    expect(
      decideOwnerProposalPreference(
        [
          decision("approved", 27),
          decision("declined", 26),
          decision("approved", 25),
        ],
        NOW,
      ).action,
    ).toBe("hold");
  });

  it("sorts decisions by decision time before applying thresholds", () => {
    const result = decideOwnerProposalPreference(
      [
        decision("approved", 25),
        decision("declined", 27),
        decision("declined", 26),
      ],
      NOW,
    );
    expect(result.action).toBe("activate");
  });

  it("matches only the intended action and proposal source", () => {
    expect(
      findProposalCooldown([lesson()], {
        actionType: "bulk_message",
        proposalSource: "weekly_strategist",
        now: NOW,
      }),
    ).toEqual({
      lessonId: "lesson-1",
      suppressUntil: "2026-08-24T17:00:00.000Z",
    });

    expect(
      findProposalCooldown([lesson()], {
        actionType: "price_change",
        proposalSource: "weekly_strategist",
        now: NOW,
      }),
    ).toBeNull();
    expect(
      findProposalCooldown([lesson()], {
        actionType: "bulk_message",
        proposalSource: "another_agent",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("automatically stops suppressing after the cooldown expires", () => {
    expect(
      findProposalCooldown([lesson()], {
        actionType: "bulk_message",
        proposalSource: "weekly_strategist",
        now: new Date("2026-08-24T17:00:00.001Z"),
      }),
    ).toBeNull();
  });
});
