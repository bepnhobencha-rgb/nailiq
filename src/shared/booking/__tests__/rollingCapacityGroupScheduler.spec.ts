import { describe, expect, it } from "vitest";

import { groupBookingInstantMatches } from "@/shared/booking/groupBookingPricing";
import {
  buildWaveArrangement,
  ceilToSlotGridMs,
  findEarliestWaveArrangement,
  tryWaveArrangement,
  type ExistingBooking,
  type ResolvedMember,
  type StaffRow,
} from "@/shared/booking/groupSchedulerCore";

const MINUTE_MS = 60_000;
const DAY_CLOSE_MS = 24 * 60 * MINUTE_MS;
const TIMEZONE = "America/Los_Angeles";
const SERVICE_ID = "classic";

function staff(count: number): StaffRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}`,
    name: `Staff ${index + 1}`,
  }));
}

function members(durations: number[]): ResolvedMember[] {
  return durations.map((totalMinutes, index) => ({
    index,
    name: `Guest ${index + 1}`,
    serviceId: SERVICE_ID,
    serviceName: "Classic",
    totalMinutes,
    priceCents: 3_000,
    preferredStaffId: null,
  }));
}

function booking(staffId: string, endMinute: number): ExistingBooking {
  return {
    staffId,
    startMs: 0,
    endMs: endMinute * MINUTE_MS,
  };
}

function startsByWave(
  arrangement: NonNullable<ReturnType<typeof tryWaveArrangement>>,
) {
  const waveNumbers = [
    ...new Set(arrangement.assignments.map((assignment) => assignment.waveNumber)),
  ].sort((left, right) => left - right);

  return waveNumbers.map((waveNumber) => {
    const inWave = arrangement.assignments.filter(
      (assignment) => assignment.waveNumber === waveNumber,
    );
    return {
      waveNumber,
      memberCount: inWave.length,
      startMinute: inWave[0].startMs / MINUTE_MS,
    };
  });
}

describe("rolling-capacity group scheduler", () => {
  it("snaps a same-day lead floor to the visible slot grid before quoting waves", () => {
    const gridOriginMs = Date.parse("2026-08-30T16:00:00.000Z");
    const leadFloorMs = Date.parse("2026-08-30T17:43:00.725Z");
    const waveAnchorMs = ceilToSlotGridMs(leadFloorMs, gridOriginMs);
    const staffList = staff(7);
    const staffById = new Map(staffList.map((row) => [row.id, row]));

    expect(new Date(waveAnchorMs).toISOString()).toBe(
      "2026-08-30T17:45:00.000Z",
    );

    const result = findEarliestWaveArrangement(
      waveAnchorMs,
      members(Array(12).fill(70)),
      staffList,
      staffById,
      null,
      [],
      Date.parse("2026-08-31T02:00:00.000Z"),
      { strategy: "maximize_revenue" },
    );

    expect(result).not.toBeNull();
    expect(
      result?.assignments.every(
        (assignment) =>
          assignment.startMs % MINUTE_MS === 0 &&
          assignment.endMs % MINUTE_MS === 0,
      ),
    ).toBe(true);
    const quotedStartIso = new Date(
      result?.assignments[0].startMs ?? Number.NaN,
    ).toISOString();
    const minuteOnlySubmitIso = new Date(quotedStartIso);
    minuteOnlySubmitIso.setUTCSeconds(0, 0);
    expect(
      groupBookingInstantMatches(
        quotedStartIso,
        minuteOnlySubmitIso.toISOString(),
      ),
    ).toBe(true);
  });

  it("keeps three guests at the requested time and fills every later release", () => {
    const staffList = staff(10);
    const staffById = new Map(staffList.map((row) => [row.id, row]));
    const existing = [
      booking("S04", 15),
      booking("S05", 20),
      booking("S06", 25),
      booking("S07", 30),
      booking("S08", 35),
      booking("S09", 40),
      booking("S10", 45),
    ];

    const result = tryWaveArrangement(
      0,
      members(Array(10).fill(60)),
      staffList,
      staffById,
      null,
      existing,
      DAY_CLOSE_MS,
      { strategy: "maximize_revenue" },
    );

    expect(result).not.toBeNull();
    expect(startsByWave(result!)).toEqual([
      { waveNumber: 1, memberCount: 3, startMinute: 0 },
      { waveNumber: 2, memberCount: 1, startMinute: 15 },
      { waveNumber: 3, memberCount: 1, startMinute: 20 },
      { waveNumber: 4, memberCount: 1, startMinute: 25 },
      { waveNumber: 5, memberCount: 1, startMinute: 30 },
      { waveNumber: 6, memberCount: 1, startMinute: 35 },
      { waveNumber: 7, memberCount: 1, startMinute: 40 },
      { waveNumber: 8, memberCount: 1, startMinute: 45 },
    ]);
  });

  it("starts two guests at 10:10 and the final guest at the 10:15 release", () => {
    const staffList = staff(7);
    const staffById = new Map(staffList.map((row) => [row.id, row]));
    const durations = [70, 70, 75, 90, 90, 90, 90, 60, 60, 60];

    const result = tryWaveArrangement(
      0,
      members(durations),
      staffList,
      staffById,
      null,
      [],
      DAY_CLOSE_MS,
      { strategy: "maximize_revenue" },
    );

    expect(result).not.toBeNull();
    expect(startsByWave(result!)).toEqual([
      { waveNumber: 1, memberCount: 7, startMinute: 0 },
      { waveNumber: 2, memberCount: 2, startMinute: 70 },
      { waveNumber: 3, memberCount: 1, startMinute: 75 },
    ]);
  });

  it("skips a blocked release and waits for the next usable capacity event", () => {
    const staffList = staff(2);
    const staffById = new Map(staffList.map((row) => [row.id, row]));
    const existing: ExistingBooking[] = [
      { staffId: "S01", startMs: 50 * MINUTE_MS, endMs: 180 * MINUTE_MS },
      { staffId: "S02", startMs: 50 * MINUTE_MS, endMs: 180 * MINUTE_MS },
    ];

    const result = tryWaveArrangement(
      0,
      members([50, 50, 50, 50]),
      staffList,
      staffById,
      null,
      existing,
      DAY_CLOSE_MS,
      { strategy: "maximize_revenue" },
    );

    expect(result).not.toBeNull();
    expect(startsByWave(result!)).toEqual([
      { waveNumber: 1, memberCount: 2, startMinute: 0 },
      { waveNumber: 2, memberCount: 2, startMinute: 180 },
    ]);
  });

  it("applies the salon cadence to each rolling release", () => {
    const staffList = staff(3);
    const staffById = new Map(staffList.map((row) => [row.id, row]));
    const party = members([67, 67, 80, 60, 60]);

    const balanced = tryWaveArrangement(
      0,
      party,
      staffList,
      staffById,
      null,
      [],
      DAY_CLOSE_MS,
      { strategy: "balanced" },
    );
    const onTime = tryWaveArrangement(
      0,
      party,
      staffList,
      staffById,
      null,
      [],
      DAY_CLOSE_MS,
      { strategy: "on_time" },
    );

    expect(startsByWave(balanced!)).toEqual([
      { waveNumber: 1, memberCount: 3, startMinute: 0 },
      { waveNumber: 2, memberCount: 2, startMinute: 70 },
    ]);
    expect(startsByWave(onTime!)).toEqual([
      { waveNumber: 1, memberCount: 3, startMinute: 0 },
      { waveNumber: 2, memberCount: 2, startMinute: 75 },
    ]);
  });

  it("returns no arrangement instead of exposing a partial group", () => {
    const staffList = staff(2);
    const staffById = new Map(staffList.map((row) => [row.id, row]));

    const result = tryWaveArrangement(
      0,
      members([60, 60, 60]),
      staffList,
      staffById,
      null,
      [],
      90 * MINUTE_MS,
      { strategy: "maximize_revenue" },
    );

    expect(result).toBeNull();
  });

  it("keeps optimization evidence aligned with overlapping waves", () => {
    const staffList = staff(7);
    const staffById = new Map(staffList.map((row) => [row.id, row]));
    const party = members([70, 70, 75, 90, 90, 90, 90, 60, 60, 60]);
    const raw = tryWaveArrangement(
      0,
      party,
      staffList,
      staffById,
      null,
      [],
      DAY_CLOSE_MS,
      { strategy: "maximize_revenue" },
    );

    expect(raw).not.toBeNull();
    const arrangement = buildWaveArrangement(raw!, party, staffById, TIMEZONE);

    expect(arrangement.waveOptimization?.decisions).toMatchObject([
      {
        waveNumber: 2,
        capacityReadyMs: 70 * MINUTE_MS,
        scheduledStartMs: 70 * MINUTE_MS,
        memberCount: 2,
      },
      {
        waveNumber: 3,
        capacityReadyMs: 75 * MINUTE_MS,
        scheduledStartMs: 75 * MINUTE_MS,
        memberCount: 1,
      },
    ]);
  });
});
