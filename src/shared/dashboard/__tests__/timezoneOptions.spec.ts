import { describe, expect, it } from "vitest";

import { defaultPhoneCountry } from "@/shared/booking/phoneCountries";
import {
  SETUP_TIMEZONE_OPTIONS,
  isAllowedTimezone,
} from "@/shared/dashboard/timezoneOptions";
import {
  salonDayRangeUtc,
  salonWallTimeToUtcIso,
} from "@/shared/lib/salonTime";

function option(value: string) {
  return SETUP_TIMEZONE_OPTIONS.find((candidate) => candidate.value === value);
}

function dayLengthHours(dateYmd: string, timezone: string): number {
  const range = salonDayRangeUtc(dateYmd, timezone);
  return (Date.parse(range.endUtc) - Date.parse(range.startUtc)) / 3_600_000;
}

describe("Canadian setup timezone mappings", () => {
  it("uses canonical IANA zones instead of assigning Yukon or Saskatchewan to a neighbour", () => {
    expect(option("America/Vancouver")).toMatchObject({
      labelEn: "BC",
      labelVi: "BC",
    });
    expect(option("America/Whitehorse")).toMatchObject({
      labelEn: "Yukon",
      labelVi: "Yukon",
    });
    expect(option("America/Winnipeg")).toMatchObject({
      labelEn: "Manitoba",
      labelVi: "Manitoba",
    });
    expect(option("America/Regina")).toMatchObject({
      labelEn: "Saskatchewan",
      labelVi: "Saskatchewan",
    });
    expect(isAllowedTimezone("America/Whitehorse")).toBe(true);
    expect(isAllowedTimezone("America/Regina")).toBe(true);
  });

  it("keeps Yukon and Saskatchewan on their no-DST 2026 offsets", () => {
    for (const dateYmd of ["2026-03-08", "2026-11-01"]) {
      expect(dayLengthHours(dateYmd, "America/Whitehorse")).toBe(24);
      expect(dayLengthHours(dateYmd, "America/Regina")).toBe(24);
    }

    expect(
      salonWallTimeToUtcIso("2026-01-15", 9 * 60, "America/Whitehorse"),
    ).toBe("2026-01-15T16:00:00.000Z");
    expect(
      salonWallTimeToUtcIso("2026-07-15", 9 * 60, "America/Whitehorse"),
    ).toBe("2026-07-15T16:00:00.000Z");
    expect(
      salonWallTimeToUtcIso("2026-01-15", 9 * 60, "America/Regina"),
    ).toBe("2026-01-15T15:00:00.000Z");
    expect(
      salonWallTimeToUtcIso("2026-07-15", 9 * 60, "America/Regina"),
    ).toBe("2026-07-15T15:00:00.000Z");
  });

  it("still applies DST in neighbouring Vancouver and Winnipeg zones", () => {
    expect(dayLengthHours("2026-03-08", "America/Vancouver")).toBe(23);
    expect(dayLengthHours("2026-11-01", "America/Vancouver")).toBe(25);
    expect(dayLengthHours("2026-03-08", "America/Winnipeg")).toBe(23);
    expect(dayLengthHours("2026-11-01", "America/Winnipeg")).toBe(25);
  });

  it("keeps the public phone country default Canadian for both new zones", () => {
    expect(defaultPhoneCountry("America/Whitehorse").iso).toBe("CA");
    expect(defaultPhoneCountry("America/Regina").iso).toBe("CA");
  });
});
