import { describe, expect, it } from "vitest";

import {
  evaluateControlledAfterHours,
  MAX_AFTER_HOURS_EXTENSION_MINUTES,
} from "@/shared/booking/controlledAfterHours";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import { canCreateAfterHoursDeskBooking } from "@/shared/lib/salonMemberRole";

const HOURS = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
    day,
    { open: "09:00", close: "19:30", closed: false },
  ]),
);

describe("controlled after-hours booking", () => {
  it("is restricted to Owner/Admin roles", () => {
    expect(canCreateAfterHoursDeskBooking("owner")).toBe(true);
    expect(canCreateAfterHoursDeskBooking("admin")).toBe(true);
    expect(canCreateAfterHoursDeskBooking("senior")).toBe(false);
    expect(canCreateAfterHoursDeskBooking("receptionist")).toBe(false);
    expect(canCreateAfterHoursDeskBooking("nail_tech")).toBe(false);
  });

  it("measures the customer-facing overrun after close", () => {
    expect(
      evaluateControlledAfterHours({
        openingHoursRaw: HOURS,
        dateYmd: "2030-05-05",
        startMinutes: 19 * 60,
        serviceCompletionMinutes: 60,
      }),
    ).toEqual({
      ok: true,
      closeMinutes: 19 * 60 + 30,
      afterHoursMinutes: 30,
    });
  });

  it("rejects normal-hours, closed-date, and over-two-hour exceptions", () => {
    expect(
      evaluateControlledAfterHours({
        openingHoursRaw: HOURS,
        dateYmd: "2030-05-05",
        startMinutes: 18 * 60 + 30,
        serviceCompletionMinutes: 60,
      }),
    ).toEqual({ ok: false, reason: "inside_hours" });
    expect(
      evaluateControlledAfterHours({
        openingHoursRaw: HOURS,
        bookingClosedDatesRaw: ["2030-05-05"],
        dateYmd: "2030-05-05",
        startMinutes: 19 * 60,
        serviceCompletionMinutes: 60,
      }),
    ).toEqual({ ok: false, reason: "closed_day" });
    expect(
      evaluateControlledAfterHours({
        openingHoursRaw: HOURS,
        dateYmd: "2030-05-05",
        startMinutes: 21 * 60,
        serviceCompletionMinutes: 45,
      }),
    ).toEqual({ ok: false, reason: "extension_too_long" });
  });

  it("only exposes extended slots when the desk explicitly requests them", () => {
    const common = {
      openingHoursRaw: HOURS,
      selectedDate: new Date(2030, 4, 5),
      staffId: "staff-1",
      staffList: [{ id: "staff-1", name: "Anna", job_role: "nail_tech" }],
      serviceDurationMinutes: 60,
      occupancy: [],
      nowMs: new Date(2030, 4, 4, 12).getTime(),
    } as const;
    const normal = computeTimeSlots(common).map((slot) => slot.label);
    const extended = computeTimeSlots({
      ...common,
      closingExtensionMinutes: MAX_AFTER_HOURS_EXTENSION_MINUTES,
      allowBeyondStaffShiftEnd: true,
    }).map((slot) => slot.label);

    expect(normal).not.toContain("7:00 PM");
    expect(extended).toContain("7:00 PM");
    expect(extended).toContain("8:30 PM");
    expect(extended).not.toContain("8:45 PM");
  });

  it("keeps staff conflicts unavailable in the extended window", () => {
    const slots = computeTimeSlots({
      openingHoursRaw: HOURS,
      selectedDate: new Date(2030, 4, 5),
      staffId: "staff-1",
      staffList: [{ id: "staff-1", name: "Anna", job_role: "nail_tech" }],
      serviceDurationMinutes: 60,
      occupancy: [
        {
          staff_id: "staff-1",
          start_time_utc: new Date(2030, 4, 5, 19, 0).toISOString(),
          end_time_utc: new Date(2030, 4, 5, 20, 0).toISOString(),
        },
      ],
      nowMs: new Date(2030, 4, 4, 12).getTime(),
      closingExtensionMinutes: MAX_AFTER_HOURS_EXTENSION_MINUTES,
      allowBeyondStaffShiftEnd: true,
    });
    expect(slots.find((slot) => slot.label === "7:00 PM")?.available).toBe(
      false,
    );
  });
});
