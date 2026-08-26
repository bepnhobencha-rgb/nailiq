import { describe, expect, it } from "vitest";
import {
  isValidBookingClosedDate,
  normalizeBookingClosedDateList,
  parseBookingClosedDateSet,
} from "@/shared/booking/parseBookingClosedDates";

describe("booking closed dates", () => {
  it("accepts real ISO calendar dates including leap day", () => {
    expect(isValidBookingClosedDate("2028-02-29")).toBe(true);
    expect(parseBookingClosedDateSet(["2028-02-29"])).toEqual(
      new Set(["2028-02-29"]),
    );
  });

  it("drops impossible dates, duplicates, and malformed values", () => {
    expect(
      normalizeBookingClosedDateList([
        "2026-02-30",
        "2026-13-01",
        "2026-12-24",
        "2026-12-24",
        "not-a-date",
      ]),
    ).toEqual(["2026-12-24"]);
  });
});
