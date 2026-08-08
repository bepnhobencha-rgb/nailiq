import { describe, expect, it } from "vitest";

import {
  firstVisitInitialFollowUpStep,
  normalizeFirstVisitFollowUpStep,
} from "@/shared/firstvisit/sequenceProgress";

describe("first-visit sequence progress", () => {
  it("starts the due queue at step 1 after immediate warmth", () => {
    expect(firstVisitInitialFollowUpStep()).toBe(1);
  });

  it("upgrades legacy step-0 rows instead of repeating warmth", () => {
    expect(normalizeFirstVisitFollowUpStep(0)).toBe(1);
    expect(normalizeFirstVisitFollowUpStep("0")).toBe(1);
  });

  it("preserves the final step", () => {
    expect(normalizeFirstVisitFollowUpStep(2)).toBe(2);
  });
});
