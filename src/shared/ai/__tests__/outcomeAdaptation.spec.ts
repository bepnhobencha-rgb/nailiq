import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: vi.fn(),
}));
vi.mock("@/shared/ai/lessonMutations", () => ({
  setOutcomeAdaptation: vi.fn(),
}));

import { decideOutcomeAdaptation } from "@/shared/ai/analyzeOutcomes";
import { applyLearnedAgentCap, type MinhLesson } from "@/shared/ai/lessons";

function lesson(input: Partial<MinhLesson> = {}): MinhLesson {
  return {
    id: "lesson-1",
    salonId: "salon-1",
    scope: "segment",
    condition: { agent: "winback" },
    rule: "cap_multiplier:0.5",
    source: "outcome_adaptation:winback",
    confidence: 0.7,
    ...input,
  };
}

describe("outcome adaptation decision", () => {
  it("does nothing before the minimum sample is meaningful", () => {
    expect(
      decideOutcomeAdaptation({
        sent: 9,
        converted: 0,
        conversionRate: 0,
      }),
    ).toBe("unchanged");
  });

  it("activates below 5% and recovers at 10% or better", () => {
    expect(
      decideOutcomeAdaptation({
        sent: 20,
        converted: 0,
        conversionRate: 0,
      }),
    ).toBe("activate");
    expect(
      decideOutcomeAdaptation({
        sent: 20,
        converted: 2,
        conversionRate: 0.1,
      }),
    ).toBe("recover");
  });

  it("uses hysteresis between reduction and recovery", () => {
    expect(
      decideOutcomeAdaptation({
        sent: 20,
        converted: 1,
        conversionRate: 0.05,
      }),
    ).toBe("unchanged");
  });
});

describe("applyLearnedAgentCap", () => {
  it("reduces only the matching agent cap", () => {
    const lessons = [lesson()];
    expect(applyLearnedAgentCap(15, lessons, "winback")).toBe(7);
    expect(applyLearnedAgentCap(15, lessons, "rebook")).toBe(15);
  });

  it("never raises a code cap or pauses the agent", () => {
    expect(
      applyLearnedAgentCap(3, [lesson({ rule: "cap_multiplier:2" })], "winback"),
    ).toBe(3);
    expect(
      applyLearnedAgentCap(3, [lesson({ rule: "cap_multiplier:0" })], "winback"),
    ).toBe(1);
  });

  it("ignores malformed and unrelated lessons", () => {
    expect(
      applyLearnedAgentCap(
        10,
        [
          lesson({ rule: "not_a_cap" }),
          lesson({ scope: "channel", rule: "cap_multiplier:0.25" }),
        ],
        "winback",
      ),
    ).toBe(10);
  });
});
