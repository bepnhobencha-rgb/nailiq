import { describe, expect, it } from "vitest";
import type { TimeSlot } from "@/shared/booking/getAvailableTimeSlots";
import {
  bestAvailableTimeSlots,
  groupTimeSlotsByPeriod,
  timeSlotLabelToMinutes,
  timeSlotPeriodForLabel,
} from "@/shared/booking/timeSlotPeriods";

const slot = (label: string, available = true, score?: number): TimeSlot => ({
  label,
  available,
  score,
});

describe("time slot period presentation", () => {
  it("parses noon and midnight without timezone drift", () => {
    expect(timeSlotLabelToMinutes("12:00 AM")).toBe(0);
    expect(timeSlotLabelToMinutes("12:00 PM")).toBe(720);
    expect(timeSlotLabelToMinutes("7:45 PM")).toBe(1185);
    expect(timeSlotLabelToMinutes("19:45")).toBeNull();
  });

  it("uses the agreed period boundaries", () => {
    expect(timeSlotPeriodForLabel("11:45 AM")).toBe("morning");
    expect(timeSlotPeriodForLabel("12:00 PM")).toBe("midday");
    expect(timeSlotPeriodForLabel("1:45 PM")).toBe("midday");
    expect(timeSlotPeriodForLabel("2:00 PM")).toBe("afternoon");
    expect(timeSlotPeriodForLabel("4:45 PM")).toBe("afternoon");
    expect(timeSlotPeriodForLabel("5:00 PM")).toBe("evening");
  });

  it("groups slots without changing their order or availability", () => {
    const input = [
      slot("9:00 AM"),
      slot("12:30 PM", false),
      slot("3:15 PM"),
      slot("6:00 PM"),
    ];
    const groups = groupTimeSlotsByPeriod(input);

    expect(groups.morning).toEqual([input[0]]);
    expect(groups.midday).toEqual([input[1]]);
    expect(groups.afternoon).toEqual([input[2]]);
    expect(groups.evening).toEqual([input[3]]);
  });

  it("suggests only available slots and respects smart scheduling scores", () => {
    const input = [
      slot("9:00 AM", true, 0),
      slot("9:15 AM", false, 100),
      slot("10:00 AM", true, 80),
      slot("11:00 AM", true, 80),
      slot("12:00 PM", true, 20),
    ];

    expect(bestAvailableTimeSlots(input, 3).map((item) => item.label)).toEqual([
      "10:00 AM",
      "11:00 AM",
      "12:00 PM",
    ]);
  });
});
