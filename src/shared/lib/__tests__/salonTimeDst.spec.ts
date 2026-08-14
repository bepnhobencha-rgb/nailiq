import { describe, expect, it } from "vitest";

import {
  formatInSalonTz,
  salonDayRangeUtc,
  salonWallTimeToUtcCandidates,
  salonWallTimeToUtcIso,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";

describe("salon time — Canadian timezone and DST boundaries", () => {
  it.each([
    {
      timezone: "America/Vancouver",
      dateYmd: "2026-07-15",
      minutes: 9 * 60 + 15,
      expectedUtc: "2026-07-15T16:15:00.000Z",
    },
    {
      timezone: "America/Toronto",
      dateYmd: "2026-01-15",
      minutes: 14 * 60,
      expectedUtc: "2026-01-15T19:00:00.000Z",
    },
    {
      timezone: "America/St_Johns",
      dateYmd: "2026-07-15",
      minutes: 9 * 60 + 15,
      expectedUtc: "2026-07-15T11:45:00.000Z",
    },
    {
      timezone: "America/Regina",
      dateYmd: "2026-07-15",
      minutes: 9 * 60 + 15,
      expectedUtc: "2026-07-15T15:15:00.000Z",
    },
  ])(
    "round-trips $timezone wall time without using the machine timezone",
    ({ timezone, dateYmd, minutes, expectedUtc }) => {
      const utcIso = salonWallTimeToUtcIso(dateYmd, minutes, timezone);

      expect(utcIso).toBe(expectedUtc);
      expect(utcIsoToSalonMinutesFromMidnight(utcIso, timezone)).toBe(minutes);
    },
  );

  it("keeps Vancouver at permanent UTC-07 after its final 2026 spring-forward", () => {
    const spring = salonDayRangeUtc("2026-03-08", "America/Vancouver");
    const fall = salonDayRangeUtc("2026-11-01", "America/Vancouver");

    expect(Date.parse(spring.endUtc) - Date.parse(spring.startUtc)).toBe(
      23 * 60 * 60 * 1000,
    );
    expect(Date.parse(fall.endUtc) - Date.parse(fall.startUtc)).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(
      salonWallTimeToUtcIso("2027-01-15", 9 * 60, "America/Vancouver"),
    ).toBe("2027-01-15T16:00:00.000Z");
  });

  it("fails closed for a spring-forward wall time that does not exist", () => {
    expect(() =>
      salonWallTimeToUtcIso(
        "2026-03-08",
        2 * 60 + 30,
        "America/Toronto",
      ),
    ).toThrow(/does not exist/i);
  });

  it("chooses the first occurrence of a repeated fall-back wall time", () => {
    expect(
      salonWallTimeToUtcCandidates(
        "2026-11-01",
        1 * 60 + 30,
        "America/Toronto",
      ),
    ).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);

    const firstOccurrence = salonWallTimeToUtcIso(
      "2026-11-01",
      1 * 60 + 30,
      "America/Toronto",
    );

    expect(firstOccurrence).toBe("2026-11-01T05:30:00.000Z");
    expect(
      formatInSalonTz(
        firstOccurrence,
        "America/Toronto",
        "datetime",
      ),
    ).toBe("Sun, Nov 1 · 1:30 AM");
  });

  it("rejects invalid calendar dates and minute values", () => {
    expect(() =>
      salonWallTimeToUtcIso("2026-02-30", 9 * 60, "America/Toronto"),
    ).toThrow(/invalid calendar date/i);
    expect(() =>
      salonWallTimeToUtcIso("2026-02-28", 24 * 60, "America/Toronto"),
    ).toThrow(/invalid minutes/i);
  });
});
