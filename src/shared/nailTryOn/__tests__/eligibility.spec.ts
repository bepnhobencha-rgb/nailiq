import { describe, expect, it } from "vitest";

import {
  isNailTryOnEligibleSalon,
  isPublicNailTryOnEligibleSalon,
} from "../eligibility";

describe("Nail Try-On salon eligibility", () => {
  it("allows only the nail-salon vertical", () => {
    expect(isNailTryOnEligibleSalon({ vertical: "nail_salon" })).toBe(true);
    expect(isNailTryOnEligibleSalon({ vertical: "head_spa" })).toBe(false);
    expect(isNailTryOnEligibleSalon({ vertical: null })).toBe(false);
  });

  it("requires an active, booking-ready public destination", () => {
    expect(
      isPublicNailTryOnEligibleSalon({
        vertical: "nail_salon",
        archived_at: null,
        profile_complete: true,
      }),
    ).toBe(true);
    expect(
      isPublicNailTryOnEligibleSalon({
        vertical: "nail_salon",
        archived_at: "2026-08-11T03:00:58.000Z",
        profile_complete: true,
      }),
    ).toBe(false);
    expect(
      isPublicNailTryOnEligibleSalon({
        vertical: "nail_salon",
        archived_at: null,
        profile_complete: false,
      }),
    ).toBe(false);
  });
});
