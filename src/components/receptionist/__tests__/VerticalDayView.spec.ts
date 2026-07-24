import { describe, expect, it } from "vitest";

import { computeVerticalSlotWindow } from "../VerticalDayView";

describe("computeVerticalSlotWindow", () => {
  it("keeps the configured opening-hours window when every item is inside it", () => {
    expect(computeVerticalSlotWindow(8 * 60, 20 * 60, [9 * 60, 17 * 60 + 15])).toEqual({
      start: 8 * 60,
      end: 20 * 60,
    });
  });

  it("widens past closing to render a late booking or no-show tombstone", () => {
    expect(computeVerticalSlotWindow(8 * 60, 20 * 60, [20 * 60 + 27])).toEqual({
      start: 8 * 60,
      end: 20 * 60 + 30,
    });
  });

  it("widens before opening and clamps the day at midnight", () => {
    expect(
      computeVerticalSlotWindow(8 * 60, 20 * 60, [7 * 60 + 42, 23 * 60 + 59]),
    ).toEqual({
      start: 7 * 60 + 30,
      end: 24 * 60,
    });
  });
});
