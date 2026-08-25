import { describe, expect, it } from "vitest";

import {
  compactOpeningHoursLabel,
  defaultOpeningHoursWeek,
} from "../openingHoursDefaults";

describe("compactOpeningHoursLabel", () => {
  it("formats the same English wall-clock label on the server and client", () => {
    expect(compactOpeningHoursLabel(defaultOpeningHoursWeek())).toBe(
      "Mon–Sat: 9:00 AM – 6:00 PM · Sun: Closed",
    );
  });

  it("handles noon and midnight without runtime locale formatting", () => {
    const hours = defaultOpeningHoursWeek();
    hours.mon = { open: "00:00", close: "12:00", closed: false };

    expect(compactOpeningHoursLabel(hours)).toContain(
      "Mon: 12:00 AM – 12:00 PM",
    );
  });
});
