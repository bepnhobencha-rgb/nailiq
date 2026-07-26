import { describe, expect, it } from "vitest";

import { computeBookingTiming } from "@/shared/booking/bookingTiming";
import { checkBookingWithinOpeningHours } from "@/shared/booking/bookingWithinOpeningHours";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";

const HOURS_TO_7_30 = {
  mon: { open: "09:00", close: "19:30", closed: false },
  tue: { open: "09:00", close: "19:30", closed: false },
  wed: { open: "09:00", close: "19:30", closed: false },
  thu: { open: "09:00", close: "19:30", closed: false },
  fri: { open: "09:00", close: "19:30", closed: false },
  sat: { open: "09:00", close: "19:30", closed: false },
  sun: { open: "09:00", close: "19:30", closed: false },
};

describe("booking closing boundary", () => {
  it("allows a 7:00 PM 30-minute service while preserving its 10-minute buffer", () => {
    const timing = computeBookingTiming({
      durationMinutes: 30,
      bufferMinutes: 10,
    });

    expect(timing).toEqual({
      blockMinutes: 40,
      serviceCompletionMinutes: 30,
      trailingBufferMinutes: 10,
    });
    expect(
      checkBookingWithinOpeningHours({
        openingHoursRaw: HOURS_TO_7_30,
        dateYmd: "2030-05-05",
        startMinutes: 19 * 60,
        serviceCompletionMinutes: timing.serviceCompletionMinutes,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects 7:15 PM because the service itself would finish after 7:30 PM", () => {
    const timing = computeBookingTiming({
      durationMinutes: 30,
      bufferMinutes: 10,
    });

    expect(
      checkBookingWithinOpeningHours({
        openingHoursRaw: HOURS_TO_7_30,
        dateYmd: "2030-05-05",
        startMinutes: 19 * 60 + 15,
        serviceCompletionMinutes: timing.serviceCompletionMinutes,
      }),
    ).toEqual({ ok: false, reason: "outside_hours" });
  });

  it("offers 7:00 PM but not 7:15 PM in the shared slot engine", () => {
    const slots = computeTimeSlots({
      openingHoursRaw: HOURS_TO_7_30,
      selectedDate: new Date(2030, 4, 5),
      staffId: BOOKING_ANY_STAFF_ID,
      staffList: [{ id: "staff-1", name: "Anna", job_role: "head_spa_tech" }],
      serviceDurationMinutes: 40,
      trailingBufferMinutes: 10,
      occupancy: [],
      nowMs: new Date(2030, 4, 4, 12).getTime(),
    }).map((slot) => slot.label);

    expect(slots).toContain("7:00 PM");
    expect(slots).not.toContain("7:15 PM");
  });

  it("keeps buffers between sequential services but excludes only the final buffer", () => {
    const timing = computeBookingTiming(
      { durationMinutes: 30, bufferMinutes: 10 },
      [
        { durationMinutes: 20, bufferMinutes: 5 },
        { durationMinutes: 15, bufferMinutes: 10, concurrent: true },
      ],
    );

    expect(timing).toEqual({
      blockMinutes: 65,
      serviceCompletionMinutes: 60,
      trailingBufferMinutes: 5,
    });
  });
});
