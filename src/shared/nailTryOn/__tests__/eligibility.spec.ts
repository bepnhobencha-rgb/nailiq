import { describe, expect, it } from "vitest";

import { isNailTryOnEligibleSalon } from "@/shared/nailTryOn/eligibility";

describe("Nail Try-On salon eligibility", () => {
  it("allows a nail salon", () => {
    expect(isNailTryOnEligibleSalon({ vertical: "nail_salon" })).toBe(true);
  });

  it.each(["head_spa", "hair_salon", "massage", "facial"])(
    "blocks a non-nail vertical: %s",
    (vertical) => {
      expect(isNailTryOnEligibleSalon({ vertical })).toBe(false);
    },
  );

  it("fails closed when vertical data is missing", () => {
    expect(isNailTryOnEligibleSalon({ vertical: null })).toBe(false);
    expect(isNailTryOnEligibleSalon({})).toBe(false);
  });
});
