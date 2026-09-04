import { describe, expect, it } from "vitest";

import type {
  StaffAvailability,
  StaffCapacityReservation,
} from "@/shared/dashboard/availabilityEngine";
import {
  projectWalkinGapSafety,
  selectWalkinGapSafeRecommendation,
} from "@/shared/dashboard/walkinGapSafety";

const NOW = "2026-09-03T17:03:00.000Z";

function reservation(
  staffId: string,
  startsAt: string,
  endsAt: string,
  overrides: Partial<StaffCapacityReservation> = {},
): StaffCapacityReservation {
  return {
    reservationId: `reservation-${staffId}-${startsAt}`,
    bookingId: `booking-${staffId}-${startsAt}`,
    scheduleModel: "single",
    segmentId: null,
    clientName: "QA guest",
    status: "confirmed",
    staffId,
    resourceId: null,
    prepMinutes: 0,
    serviceStartsAt: startsAt,
    serviceEndsAt: endsAt,
    occupiedStartsAt: startsAt,
    occupiedEndsAt: endsAt,
    groupId: null,
    ...overrides,
  };
}

function candidate(
  staffId: string,
  reservations: StaffCapacityReservation[] = [],
  overrides: Partial<StaffAvailability> = {},
): StaffAvailability {
  return {
    staffId,
    staffName: staffId,
    currentBooking: null,
    reservations,
    isAvailableNow: true,
    estimatedReadyAt: NOW,
    waitMinutes: 0,
    queueAhead: 0,
    bookingsNext2h: reservations.length,
    overloaded: false,
    confidenceLevel: "high",
    nextGroupBookingAt: null,
    ...overrides,
  };
}

describe("walk-in gap safety", () => {
  it("does not call a technician ready now when service plus buffer overlaps the next appointment", () => {
    const tech = candidate("Tech 01", [
      reservation(
        "Tech 01",
        "2026-09-03T17:15:00.000Z",
        "2026-09-03T17:55:00.000Z",
      ),
    ]);

    const projected = projectWalkinGapSafety(tech, NOW, {
      duration_minutes: 30,
      buffer_minutes: 10,
    });

    expect(projected.isAvailableNow).toBe(false);
    expect(projected.estimatedReadyAt).toBe("2026-09-03T17:55:00.000Z");
    expect(projected.waitMinutes).toBe(52);
  });

  it("allows an immediate assignment when the occupied block ends exactly at the next reservation", () => {
    const tech = candidate("Tech 01", [
      reservation(
        "Tech 01",
        "2026-09-03T17:43:00.000Z",
        "2026-09-03T18:23:00.000Z",
      ),
    ]);

    const projected = projectWalkinGapSafety(tech, NOW, {
      duration_minutes: 30,
      buffer_minutes: 10,
    });

    expect(projected.isAvailableNow).toBe(true);
    expect(projected.estimatedReadyAt).toBe(NOW);
  });

  it("skips an unsafe top-ranked technician and chooses the next safe technician", () => {
    const unsafe = candidate("Tech 01", [
      reservation(
        "Tech 01",
        "2026-09-03T17:15:00.000Z",
        "2026-09-03T17:55:00.000Z",
      ),
    ]);
    const safe = candidate("Tech 02");

    const selected = selectWalkinGapSafeRecommendation(
      [unsafe, safe],
      NOW,
      { duration_minutes: 30, buffer_minutes: 10 },
      "",
    );

    expect(selected?.staffId).toBe("Tech 02");
    expect(selected?.isAvailableNow).toBe(true);
  });

  it("does not silently replace an explicitly requested technician", () => {
    const requested = candidate("Tech 01", [
      reservation(
        "Tech 01",
        "2026-09-03T17:15:00.000Z",
        "2026-09-03T17:55:00.000Z",
      ),
    ]);
    const alternate = candidate("Tech 02");

    const selected = selectWalkinGapSafeRecommendation(
      [requested, alternate],
      NOW,
      { duration_minutes: 30, buffer_minutes: 10 },
      "Tech 01",
    );

    expect(selected?.staffId).toBe("Tech 01");
    expect(selected?.isAvailableNow).toBe(false);
    expect(selected?.estimatedReadyAt).toBe("2026-09-03T17:55:00.000Z");
  });

  it("ignores reservations belonging to another technician", () => {
    const tech = candidate("Tech 01", [
      reservation(
        "Tech 02",
        "2026-09-03T17:05:00.000Z",
        "2026-09-03T17:55:00.000Z",
      ),
    ]);

    const projected = projectWalkinGapSafety(tech, NOW, {
      duration_minutes: 30,
      buffer_minutes: 10,
    });

    expect(projected.isAvailableNow).toBe(true);
  });

  it("finds the first full gap after consecutive reservations", () => {
    const tech = candidate(
      "Tech 01",
      [
        reservation(
          "Tech 01",
          "2026-09-03T17:00:00.000Z",
          "2026-09-03T17:30:00.000Z",
        ),
        reservation(
          "Tech 01",
          "2026-09-03T17:30:00.000Z",
          "2026-09-03T18:00:00.000Z",
        ),
      ],
      {
        isAvailableNow: false,
      },
    );

    const projected = projectWalkinGapSafety(tech, NOW, {
      duration_minutes: 30,
      buffer_minutes: 10,
    });

    expect(projected.isAvailableNow).toBe(false);
    expect(projected.estimatedReadyAt).toBe("2026-09-03T18:00:00.000Z");
    expect(projected.waitMinutes).toBe(57);
  });

  it("uses occupied sequence windows rather than customer-visible service times", () => {
    const tech = candidate("Tech 01", [
      reservation(
        "Tech 01",
        "2026-09-03T17:15:00.000Z",
        "2026-09-03T17:55:00.000Z",
        {
          scheduleModel: "segments_v1",
          segmentId: "segment-1",
          serviceStartsAt: "2026-09-03T17:25:00.000Z",
          serviceEndsAt: "2026-09-03T17:45:00.000Z",
        },
      ),
    ]);

    const projected = projectWalkinGapSafety(tech, NOW, {
      duration_minutes: 20,
      buffer_minutes: 0,
    });

    expect(projected.isAvailableNow).toBe(false);
    expect(projected.estimatedReadyAt).toBe("2026-09-03T17:55:00.000Z");
  });

  it("compares absolute instants correctly when ISO values use timezone offsets", () => {
    const tech = candidate("Tech 01", [
      reservation(
        "Tech 01",
        "2026-09-03T10:15:00.000-07:00",
        "2026-09-03T10:55:00.000-07:00",
      ),
    ]);

    const projected = projectWalkinGapSafety(tech, NOW, {
      duration_minutes: 30,
      buffer_minutes: 10,
    });

    expect(projected.isAvailableNow).toBe(false);
    expect(projected.estimatedReadyAt).toBe("2026-09-03T17:55:00.000Z");
  });

  it("fails closed when service duration or reservation data is invalid", () => {
    const tech = candidate("Tech 01");
    const invalidService = projectWalkinGapSafety(tech, NOW, {
      duration_minutes: 0,
      buffer_minutes: 10,
    });
    expect(invalidService.isAvailableNow).toBe(false);
    expect(invalidService.confidenceLevel).toBe("low");

    const invalidBuffer = projectWalkinGapSafety(tech, NOW, {
      duration_minutes: 30,
      buffer_minutes: -1,
    });
    expect(invalidBuffer.isAvailableNow).toBe(false);
    expect(invalidBuffer.confidenceLevel).toBe("low");

    const malformedReservation = candidate("Tech 01", [
      reservation("Tech 01", "not-a-date", "also-not-a-date"),
    ]);
    const invalidReservation = projectWalkinGapSafety(
      malformedReservation,
      NOW,
      { duration_minutes: 30, buffer_minutes: 10 },
    );
    expect(invalidReservation.isAvailableNow).toBe(false);
    expect(invalidReservation.confidenceLevel).toBe("low");
  });
});
