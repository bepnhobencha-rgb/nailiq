import { describe, expect, it } from "vitest";

import { isSalonProfileComplete } from "../profileCompletion";

describe("isSalonProfileComplete", () => {
  it("allows a Free/trial salon with one active staff member", () => {
    expect(
      isSalonProfileComplete({
        activeServiceCount: 1,
        activeStaffCount: 1,
        address: "123 Main St, Vancouver, BC",
      }),
    ).toBe(true);
  });

  it.each([
    {
      activeServiceCount: 0,
      activeStaffCount: 1,
      address: "123 Main St",
    },
    {
      activeServiceCount: 1,
      activeStaffCount: 0,
      address: "123 Main St",
    },
    { activeServiceCount: 1, activeStaffCount: 1, address: "   " },
  ])("rejects an incomplete operating profile: %o", (input) => {
    expect(isSalonProfileComplete(input)).toBe(false);
  });
});
