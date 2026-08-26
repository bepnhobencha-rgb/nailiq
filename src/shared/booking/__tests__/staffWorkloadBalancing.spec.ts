import { describe, expect, it } from "vitest";

import {
  tryAlignedArrangement,
  type ExistingBooking,
  type ResolvedMember,
  type StaffRow,
} from "../groupSchedulerCore";

const MINUTE = 60_000;
const STAFF: StaffRow[] = [
  { id: "staff-b", name: "Bob" },
  { id: "staff-a", name: "Alice" },
];
const STAFF_BY_ID = new Map(STAFF.map((staff) => [staff.id, staff]));

function member(preferredStaffId: string | null = null): ResolvedMember {
  return {
    index: 0,
    name: "QA guest",
    serviceId: "service-1",
    serviceName: "QA service",
    totalMinutes: 30,
    priceCents: 3_000,
    preferredStaffId,
  };
}

function occupiedMinutes(existing: ExistingBooking[], staffId: string): number {
  return existing
    .filter((booking) => booking.staffId === staffId)
    .reduce(
      (total, booking) => total + (booking.endMs - booking.startMs) / MINUTE,
      0,
    );
}

describe("MQA-0174 staff workload balancing", () => {
  it("assigns Any to the capable free staff with the lowest projected salon-day minutes", () => {
    const anchor = Date.parse("2030-06-15T12:00:00Z");
    const existing: ExistingBooking[] = [
      {
        staffId: "staff-a",
        startMs: Date.parse("2030-06-15T08:00:00Z"),
        endMs: Date.parse("2030-06-15T11:00:00Z"),
      },
      {
        staffId: "staff-b",
        startMs: Date.parse("2030-06-15T08:00:00Z"),
        endMs: Date.parse("2030-06-15T09:00:00Z"),
      },
    ];

    const result = tryAlignedArrangement(
      anchor,
      [member()],
      STAFF,
      STAFF_BY_ID,
      null,
      existing,
      true,
    );

    expect(result?.assignments[0]?.staffId).toBe("staff-b");
  });

  it("uses stable staff ID order for equal projected minutes, not database order", () => {
    const anchor = Date.parse("2030-06-15T12:00:00Z");

    const result = tryAlignedArrangement(
      anchor,
      [member()],
      STAFF,
      STAFF_BY_ID,
      null,
      [],
      true,
    );

    expect(result?.assignments[0]?.staffId).toBe("staff-a");
  });

  it("preserves an explicit capable and available staff preference", () => {
    const anchor = Date.parse("2030-06-15T12:00:00Z");
    const existing: ExistingBooking[] = [
      {
        staffId: "staff-b",
        startMs: Date.parse("2030-06-15T08:00:00Z"),
        endMs: Date.parse("2030-06-15T11:00:00Z"),
      },
    ];

    const result = tryAlignedArrangement(
      anchor,
      [member("staff-b")],
      STAFF,
      STAFF_BY_ID,
      null,
      existing,
      true,
    );

    expect(result?.assignments[0]?.staffId).toBe("staff-b");
  });

  it("beats the first-row baseline across a 12-assignment QA corpus", () => {
    const existing: ExistingBooking[] = [];
    const baseline: ExistingBooking[] = [];
    const dayStart = Date.parse("2030-06-15T08:00:00Z");

    for (let index = 0; index < 12; index += 1) {
      const startMs = dayStart + index * 30 * MINUTE;
      const endMs = startMs + 30 * MINUTE;
      const result = tryAlignedArrangement(
        startMs,
        [member()],
        STAFF,
        STAFF_BY_ID,
        null,
        existing,
        true,
      );
      const staffId = result?.assignments[0]?.staffId;
      expect(staffId).toBeDefined();
      existing.push({ staffId: staffId!, startMs, endMs });

      // Previous behavior selected the first free database row every time.
      baseline.push({ staffId: STAFF[0].id, startMs, endMs });
    }

    const balancedGap = Math.abs(
      occupiedMinutes(existing, "staff-a")
        - occupiedMinutes(existing, "staff-b"),
    );
    const baselineGap = Math.abs(
      occupiedMinutes(baseline, "staff-a")
        - occupiedMinutes(baseline, "staff-b"),
    );

    expect(balancedGap).toBe(0);
    expect(baselineGap).toBe(360);
    expect(balancedGap).toBeLessThan(baselineGap);
  });
});
