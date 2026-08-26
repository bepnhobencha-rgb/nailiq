import { describe, expect, it } from "vitest";

import { computeStaffFloatGapMinutes } from "@/shared/booking/computeStaffFloatGapMinutes";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import { resolvePublicBookingSalonDay } from "@/shared/booking/publicBookingSalonDay";
import { salonTodayCalendarDate } from "@/shared/booking/salonCalendarDate";
import type { OpeningHoursWeek } from "@/shared/dashboard/openingHoursDefaults";
import {
  salonDayRangeUtc,
  salonWallTimeToUtcIso,
} from "@/shared/lib/salonTime";

const VANCOUVER = "America/Vancouver";
const STAFF_ID = "11111111-1111-4111-8111-111111111111";

function week(day: "thu" | "sun", close: string): OpeningHoursWeek {
  const closed = { open: "09:00", close: "18:00", closed: true };
  return {
    mon: { ...closed },
    tue: { ...closed },
    wed: { ...closed },
    thu: { ...closed },
    fri: { ...closed },
    sat: { ...closed },
    sun: { ...closed },
    [day]: { open: "00:00", close, closed: false },
  };
}

describe("MQA-0210 salon-local booking date around midnight", () => {
  it("keeps the public calendar on the salon's date across the UTC crossover", () => {
    const beforeSalonMidnight = salonTodayCalendarDate(
      VANCOUVER,
      "2026-08-21T06:59:59.000Z",
    );
    expect([
      beforeSalonMidnight.getFullYear(),
      beforeSalonMidnight.getMonth() + 1,
      beforeSalonMidnight.getDate(),
    ]).toEqual([2026, 8, 20]);

    const afterSalonMidnight = salonTodayCalendarDate(
      VANCOUVER,
      "2026-08-21T07:00:00.000Z",
    );
    expect([
      afterSalonMidnight.getFullYear(),
      afterSalonMidnight.getMonth() + 1,
      afterSalonMidnight.getDate(),
    ]).toEqual([2026, 8, 21]);
  });

  it("uses exact half-open Vancouver days at ordinary and DST midnights", () => {
    expect(salonDayRangeUtc("2026-08-20", VANCOUVER)).toEqual({
      startUtc: "2026-08-20T07:00:00.000Z",
      endUtc: "2026-08-21T07:00:00.000Z",
    });
    expect(salonDayRangeUtc("2026-03-08", VANCOUVER)).toEqual({
      startUtc: "2026-03-08T08:00:00.000Z",
      endUtc: "2026-03-09T07:00:00.000Z",
    });
    expect(salonDayRangeUtc("2026-11-01", VANCOUVER)).toEqual({
      startUtc: "2026-11-01T07:00:00.000Z",
      endUtc: "2026-11-02T08:00:00.000Z",
    });
  });

  it("does not reject the salon's late evening merely because UTC is on tomorrow", () => {
    expect(resolvePublicBookingSalonDay(
      "2026-08-20",
      VANCOUVER,
      "2026-08-21T06:30:00.000Z",
    )).toEqual({
      dateYmd: "2026-08-20",
      startUtc: "2026-08-20T07:00:00.000Z",
      endUtc: "2026-08-21T07:00:00.000Z",
      isPast: false,
    });
    expect(resolvePublicBookingSalonDay(
      "2026-08-20",
      VANCOUVER,
      "2026-08-21T07:00:00.000Z",
    )?.isPast).toBe(true);
    expect(resolvePublicBookingSalonDay("2026-02-30", VANCOUVER)).toBeNull();
  });

  it("turns midnight/noon labels into the exact salon-local instants", () => {
    expect(parseTimeSlotToMinutes("12:00 AM")).toBe(0);
    expect(parseTimeSlotToMinutes("12:00 PM")).toBe(720);
    expect(salonWallTimeToUtcIso("2026-08-21", 0, VANCOUVER)).toBe(
      "2026-08-21T07:00:00.000Z",
    );
    expect(() => parseTimeSlotToMinutes("12:99 AM")).toThrow("invalid_time_slot");
    expect(() => parseTimeSlotToMinutes("00:30 AM")).toThrow("invalid_time_slot");
  });

  it("computes post-midnight float against salon close, not browser midnight", () => {
    const slotEndMs = Date.parse("2026-08-21T06:30:00.000Z"); // Aug 20 23:30 PDT
    expect(computeStaffFloatGapMinutes({
      occIntervals: [],
      staffId: STAFF_ID,
      slotEndMs,
      dateYmd: "2026-08-20",
      timezone: VANCOUVER,
      week: week("thu", "23:59"),
    })).toBe(29);
  });

  it("fails closed when a configured close minute does not exist on spring-forward day", () => {
    expect(computeStaffFloatGapMinutes({
      occIntervals: [],
      staffId: STAFF_ID,
      slotEndMs: Date.parse("2026-03-08T09:30:00.000Z"),
      dateYmd: "2026-03-08",
      timezone: VANCOUVER,
      week: week("sun", "02:30"),
    })).toBe(0);
  });

  it("does not fabricate spring-forward slots for a salon open after midnight", () => {
    const slots = computeTimeSlots({
      openingHoursRaw: week("sun", "04:00"),
      selectedDate: new Date(2026, 2, 8, 12, 0, 0),
      staffId: STAFF_ID,
      staffList: [{ id: STAFF_ID, name: "Linh", job_role: "nail_tech" }],
      serviceDurationMinutes: 15,
      occupancy: [],
      nowMs: Date.parse("2026-03-07T20:00:00.000Z"),
      leadMs: 0,
      timezone: VANCOUVER,
    });
    const labels = slots.map((slot) => slot.label);
    expect(labels).toContain("1:45 AM");
    expect(labels).toContain("3:00 AM");
    expect(labels).not.toContain("2:00 AM");
    expect(labels).not.toContain("2:30 AM");
  });
});
