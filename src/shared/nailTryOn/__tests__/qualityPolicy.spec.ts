import { describe, expect, it } from "vitest";
import { decideServerQuality } from "../qualityPolicy";

describe("decideServerQuality", () => {
  it("passes a clear five-nail photo without a warning", () => {
    expect(decideServerQuality({ verdict: "pass", visibleNails: 5, reason: "clear" })).toEqual({
      passed: true, warning: false, code: null,
    });
  });

  it("allows a usable imperfect photo with a warning", () => {
    expect(decideServerQuality({ verdict: "nails_occluded", visibleNails: 4, reason: "one nail partly hidden" })).toEqual({
      passed: true, warning: true, code: "nails_occluded",
    });
    expect(decideServerQuality({ verdict: "wrong_pose", visibleNails: 3, reason: "angled hand" }).passed).toBe(true);
  });

  it("still blocks photos without a usable hand", () => {
    expect(decideServerQuality({ verdict: "hand_not_found", visibleNails: 0, reason: "none" }).passed).toBe(false);
    expect(decideServerQuality({ verdict: "multiple_hands", visibleNails: 8, reason: "two hands" }).passed).toBe(false);
    expect(decideServerQuality({ verdict: "nails_occluded", visibleNails: 2, reason: "not enough nails" }).passed).toBe(false);
  });
});
