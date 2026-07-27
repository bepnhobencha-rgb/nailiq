import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { MinhLesson } from "@/shared/ai/lessons";
import {
  deriveAiOperatingHealth,
  deriveLearnedAiControls,
} from "@/shared/ai/operatingState";

const NOW = new Date("2026-07-27T18:00:00.000Z");

function lesson(overrides: Partial<MinhLesson> = {}): MinhLesson {
  return {
    id: "lesson-1",
    salonId: "salon-1",
    scope: "policy",
    condition: {
      action_type: "bulk_message",
      proposal_source: "weekly_strategist",
      suppress_until: "2026-08-24T18:00:00.000Z",
    },
    rule: "proposal_cooldown",
    source: "owner_preference:bulk_message:weekly_strategist",
    confidence: 0.8,
    ...overrides,
  };
}

describe("AI operating state", () => {
  it("prioritizes failures and stalled workers over lesser queue states", () => {
    expect(
      deriveAiOperatingHealth({
        queued: 2,
        waitingInput: 3,
        running: 1,
        failed: 1,
        stalled: 1,
      }),
    ).toEqual({
      tone: "issue",
      queued: 2,
      waitingInput: 3,
      running: 1,
      failed: 1,
      stalled: 1,
      activeWork: 3,
      needsAttention: 5,
    });
  });

  it("distinguishes owner input, active work, and an idle healthy queue", () => {
    expect(
      deriveAiOperatingHealth({
        queued: 0,
        waitingInput: 1,
        running: 0,
        failed: 0,
        stalled: 0,
      }).tone,
    ).toBe("attention");
    expect(
      deriveAiOperatingHealth({
        queued: 1,
        waitingInput: 0,
        running: 1,
        failed: 0,
        stalled: 0,
      }).tone,
    ).toBe("active");
    expect(
      deriveAiOperatingHealth({
        queued: 0,
        waitingInput: 0,
        running: 0,
        failed: 0,
        stalled: 0,
      }).tone,
    ).toBe("healthy");
  });

  it("shows only live controls learned from the current salon", () => {
    const controls = deriveLearnedAiControls(
      "salon-1",
      [
        lesson(),
        lesson({
          id: "other-salon",
          salonId: "salon-2",
          condition: {
            action_type: "bulk_message",
            suppress_until: "2026-09-01T00:00:00.000Z",
          },
        }),
        lesson({
          id: "global",
          salonId: null,
          scope: "segment",
          condition: { agent: "winback" },
          rule: "cap_multiplier:0.5",
        }),
        lesson({
          id: "pace",
          scope: "segment",
          condition: { agent: "rebook" },
          rule: "cap_multiplier:0.5",
        }),
      ],
      NOW,
    );

    expect(controls).toEqual([
      {
        kind: "proposal_cooldown",
        actionType: "bulk_message",
        proposalSource: "weekly_strategist",
        suppressUntil: "2026-08-24T18:00:00.000Z",
      },
      { kind: "reduced_pace", agent: "rebook", capMultiplier: 0.5 },
    ]);
  });

  it("does not present expired or invalid adaptations as active", () => {
    expect(
      deriveLearnedAiControls(
        "salon-1",
        [
          lesson({
            condition: {
              action_type: "bulk_message",
              suppress_until: "2026-07-27T17:59:59.000Z",
            },
          }),
          lesson({
            scope: "segment",
            condition: { agent: "winback" },
            rule: "cap_multiplier:1",
          }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });
});
