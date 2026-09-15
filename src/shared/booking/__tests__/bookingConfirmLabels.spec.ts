import { describe, expect, it } from "vitest";

import { formatBookingSlotDisplay } from "../bookingConfirmLabels";

describe("formatBookingSlotDisplay", () => {
  const selectedDate = new Date(2026, 8, 15, 12);

  it("keeps the English confirmation label in English", () => {
    const label = formatBookingSlotDisplay(
      selectedDate,
      "4:00 PM UTC",
      "en",
    );

    expect(label).toMatch(/Tue, Sep 15, 2026/);
    expect(label).toContain("4:00 PM UTC");
  });

  it("renders the confirmation date in Vietnamese on the Vietnamese flow", () => {
    const label = formatBookingSlotDisplay(
      selectedDate,
      "4:00 PM UTC",
      "vi",
    );

    expect(label).not.toMatch(/Tue|Sep/);
    expect(label).toMatch(/15.*9.*2026/);
    expect(label).toContain("4:00 PM UTC");
  });
});
