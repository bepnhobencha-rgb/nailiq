import { describe, expect, it } from "vitest";
import { restoreOriginalBookingSlot } from "../editBookingSlotTruth";

describe("edit booking original-slot truth", () => {
  it("restores the current slot when public availability marks self-occupancy busy", () => {
    expect(restoreOriginalBookingSlot(
      [
        { label: "3:45 PM", available: true },
        { label: "4:00 PM", available: false },
        { label: "4:15 PM", available: false },
      ],
      { sameSalonDay: true, originalSlotLabel: "4:00 PM" },
    )).toEqual([
      { label: "3:45 PM", available: true },
      { label: "4:00 PM", available: true },
      { label: "4:15 PM", available: false },
    ]);
  });

  it("injects only the original slot when availability is temporarily unavailable", () => {
    expect(restoreOriginalBookingSlot([], {
      sameSalonDay: true,
      originalSlotLabel: "4:00 PM",
    })).toEqual([{ label: "4:00 PM", available: true }]);
  });

  it("does not invent a slot on another day", () => {
    expect(restoreOriginalBookingSlot([], {
      sameSalonDay: false,
      originalSlotLabel: "4:00 PM",
    })).toEqual([]);
  });
});
