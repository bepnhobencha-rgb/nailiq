import { describe, expect, it } from "vitest";

import { computeBookingTiming } from "@/shared/booking/bookingTiming";
import { checkGroupWithinOpeningHours } from "@/shared/booking/groupBookingHoursPolicy";

const HOURS = {
  mon: { open: "09:00", close: "19:30", closed: false },
  tue: { open: "09:00", close: "19:30", closed: false },
  wed: { open: "09:00", close: "19:30", closed: false },
  thu: { open: "09:00", close: "19:30", closed: false },
  fri: { open: "09:00", close: "19:30", closed: false },
  sat: { open: "09:00", close: "19:30", closed: false },
  sun: { open: "09:00", close: "19:30", closed: false },
};

describe("group booking hours policy", () => {
  it("accepts every member when services finish by close", () => {
    expect(
      checkGroupWithinOpeningHours({
        openingHoursRaw: HOURS,
        members: [
          { dateYmd: "2030-05-05", startMinutes: 18 * 60, serviceCompletionMinutes: 60 },
          { dateYmd: "2030-05-05", startMinutes: 19 * 60, serviceCompletionMinutes: 30 },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it("identifies the exact late member", () => {
    expect(
      checkGroupWithinOpeningHours({
        openingHoursRaw: HOURS,
        members: [
          { dateYmd: "2030-05-05", startMinutes: 18 * 60, serviceCompletionMinutes: 60 },
          { dateYmd: "2030-05-05", startMinutes: 19 * 60 + 15, serviceCompletionMinutes: 30 },
        ],
      }),
    ).toEqual({ ok: false, memberIndex: 1, reason: "outside_hours" });
  });

  it("counts sequential add-ons but excludes only the final cleanup buffer", () => {
    const timing = computeBookingTiming(
      { durationMinutes: 30, bufferMinutes: 10 },
      [
        { durationMinutes: 20, bufferMinutes: 5 },
        { durationMinutes: 15, bufferMinutes: 10, concurrent: true },
      ],
    );

    expect(timing.serviceCompletionMinutes).toBe(60);
    expect(
      checkGroupWithinOpeningHours({
        openingHoursRaw: HOURS,
        members: [
          {
            dateYmd: "2030-05-05",
            startMinutes: 18 * 60 + 30,
            serviceCompletionMinutes: timing.serviceCompletionMinutes,
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a configured closed date even when weekly hours are open", () => {
    expect(
      checkGroupWithinOpeningHours({
        openingHoursRaw: HOURS,
        bookingClosedDatesRaw: ["2030-05-05"],
        members: [
          { dateYmd: "2030-05-05", startMinutes: 10 * 60, serviceCompletionMinutes: 30 },
        ],
      }),
    ).toEqual({ ok: false, memberIndex: 0, reason: "closed_day" });
  });
});
