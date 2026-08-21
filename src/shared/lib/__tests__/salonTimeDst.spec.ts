import { describe, expect, it } from "vitest";

import {
  resolveSalonWallTime,
  salonDayRangeUtc,
  salonWallTimeToUtcIso,
} from "../salonTime";

const VANCOUVER = "America/Vancouver";

describe("salonTime DST contract", () => {
  it("uses exact 23-hour and 25-hour half-open salon days", () => {
    const spring = salonDayRangeUtc("2026-03-08", VANCOUVER);
    expect(spring).toEqual({
      startUtc: "2026-03-08T08:00:00.000Z",
      endUtc: "2026-03-09T07:00:00.000Z",
    });
    expect(Date.parse(spring.endUtc) - Date.parse(spring.startUtc)).toBe(23 * 60 * 60 * 1000);

    const fall = salonDayRangeUtc("2026-11-01", VANCOUVER);
    expect(fall).toEqual({
      startUtc: "2026-11-01T07:00:00.000Z",
      endUtc: "2026-11-02T08:00:00.000Z",
    });
    expect(Date.parse(fall.endUtc) - Date.parse(fall.startUtc)).toBe(25 * 60 * 60 * 1000);
  });

  it("rejects a nonexistent spring-forward wall minute instead of moving the booking", () => {
    expect(resolveSalonWallTime("2026-03-08", 2 * 60 + 30, VANCOUVER)).toEqual({
      kind: "nonexistent",
      candidatesUtc: [],
    });
    expect(() => salonWallTimeToUtcIso("2026-03-08", 2 * 60 + 30, VANCOUVER)).toThrow(
      "nonexistent wall time",
    );
  });

  it("exposes both fall-back occurrences and applies an explicit policy", () => {
    expect(resolveSalonWallTime("2026-11-01", 90, VANCOUVER)).toEqual({
      kind: "ambiguous",
      candidatesUtc: ["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"],
    });
    expect(salonWallTimeToUtcIso("2026-11-01", 90, VANCOUVER)).toBe(
      "2026-11-01T08:30:00.000Z",
    );
    expect(salonWallTimeToUtcIso("2026-11-01", 90, VANCOUVER, "later")).toBe(
      "2026-11-01T09:30:00.000Z",
    );
    expect(() => salonWallTimeToUtcIso("2026-11-01", 90, VANCOUVER, "reject")).toThrow(
      "ambiguous wall time",
    );
  });

  it("keeps ordinary wall time exact and rejects invalid minute input", () => {
    expect(resolveSalonWallTime("2026-05-02", 9 * 60 + 15, VANCOUVER)).toEqual({
      kind: "exact",
      candidatesUtc: ["2026-05-02T16:15:00.000Z"],
    });
    expect(() => resolveSalonWallTime("2026-05-02", 1440, VANCOUVER)).toThrow(
      "minutesFromMidnight",
    );
  });
});
