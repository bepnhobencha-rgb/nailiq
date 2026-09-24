import { describe, expect, it } from "vitest";
import {
  formatClientProfileDate as date,
  formatClientProfileDateShort as shortDate,
  formatClientProfileTime as time,
} from "../clientProfileDateTime";

describe("Customer 360 salon date/time", () => {
  it("shows the salon's clock, not the viewer's", () => {
    expect(time("2026-09-24T07:00:00Z", "UTC")).toBe("07:00");
    expect(time("2026-09-24T07:00:00Z", "America/Los_Angeles")).toBe("00:00");
    expect(time("2026-09-24T07:00:00Z", "Asia/Ho_Chi_Minh")).toBe("14:00");
  });

  it("uses the same salon day in English, Vietnamese and short dates", () => {
    const instant = "2026-09-24T06:30:00Z";
    expect(date(instant, "en", "UTC")).toBe("9/24/2026");
    expect(date(instant, "en", "America/Los_Angeles")).toBe("9/23/2026");
    expect(date(instant, "vi", "America/Los_Angeles")).toBe("23/9/2026");
    expect(shortDate(instant, "en", "America/Los_Angeles")).toBe("Sep 23, 2026");
    expect(time(instant, "America/Los_Angeles")).toBe("23:30");
  });

  it.each([
    ["2026-03-08T09:59:00Z", "01:59"],
    ["2026-03-08T10:00:00Z", "03:00"],
    ["2026-11-01T08:30:00Z", "01:30"],
    ["2026-11-01T09:30:00Z", "01:30"],
  ])("resolves DST instant %s as %s", (instant, expected) => {
    expect(time(instant, "America/Los_Angeles")).toBe(expected);
  });

  it("keeps date-only voucher/prediction values on their calendar day", () => {
    for (const zone of ["America/Los_Angeles", "Pacific/Kiritimati"]) {
      expect(date("2026-09-24", "en", zone)).toBe("9/24/2026");
      expect(date("2026-09-24", "vi", zone)).toBe("24/9/2026");
    }
  });

  it("keeps missing/invalid data safe without defaulting to the viewer's zone", () => {
    expect(date(null, "en", "UTC")).toBe("—");
    expect(date("invalid", "vi", "UTC")).toBe("invalid");
    expect(time("invalid", "UTC")).toBe("");
    for (const zone of ["", "not-a-zone"]) {
      expect(date("2026-09-24T07:00:00Z", "en", zone)).toBe("—");
      expect(time("2026-09-24T07:00:00Z", zone)).toBe("");
    }
  });
});
