import { afterEach, describe, expect, it, vi } from "vitest";
import { getUserMessages } from "@/shared/i18n/user";
import { formatWaitlistDate, waitlistDurationParts } from "../waitlistPresentation";

afterEach(() => vi.unstubAllEnvs());

describe("waitlist calendar dates", () => {
  it.each(["America/Los_Angeles", "Pacific/Honolulu", "Pacific/Kiritimati", "Asia/Ho_Chi_Minh"])(
    "preserves the salon calendar day in %s", (timeZone) => {
      vi.stubEnv("TZ", timeZone);
      expect(formatWaitlistDate("2026-09-20", "en")).toBe("Sep 20, 2026");
      expect(formatWaitlistDate("2026-09-20", "vi")).toBe("20 thg 9, 2026");
      expect(formatWaitlistDate("2026-11-01", "en")).toBe("Nov 1, 2026");
      expect(formatWaitlistDate("2026-03-08", "en")).toBe("Mar 8, 2026");
    },
  );
  it("accepts a leap date", () => {
    expect(formatWaitlistDate("2028-02-29", "en")).toBe("Feb 29, 2028");
  });
  it.each(["", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-09-00", "2026-9-20", "2026-09-20T00:00:00Z", "invalid"])(
    "does not silently normalize an invalid calendar date: %s", (value) => {
      expect(formatWaitlistDate(value, "en")).toBe("—");
    },
  );
});

describe("waitlist presentation copy", () => {
  it.each([NaN, Infinity, -1])("does not invent a duration for %s", (minutes) => {
    expect(waitlistDurationParts(minutes)).toBeNull();
    for (const language of ["en", "vi"] as const) {
      expect(getUserMessages(language).receptionist.waitlist.waitingMinutes(minutes)).toBe("—");
    }
  });
  it("floors fractional minutes for display", () => {
    expect(waitlistDurationParts(60.9)).toEqual({ days: 0, hours: 1, minutes: 0 });
  });
  it.each([
    [0, "Waiting now", "Vừa vào danh sách chờ"],
    [59, "Waiting 59 min", "Đã chờ 59 phút"],
    [60, "Waiting 1 hr", "Đã chờ 1 giờ"],
    [61, "Waiting 1 hr 1 min", "Đã chờ 1 giờ 1 phút"],
    [1439, "Waiting 23 hr 59 min", "Đã chờ 23 giờ 59 phút"],
    [1440, "Waiting 1 day", "Đã chờ 1 ngày"],
    [1441, "Waiting 1 day 1 min", "Đã chờ 1 ngày 1 phút"],
    [13717, "Waiting 9 days 12 hr 37 min", "Đã chờ 9 ngày 12 giờ 37 phút"],
  ])("formats %i minutes without rounding up", (minutes, en, vi) => {
    expect(getUserMessages("en").receptionist.waitlist.waitingMinutes(minutes)).toBe(en);
    expect(getUserMessages("vi").receptionist.waitlist.waitingMinutes(minutes)).toBe(vi);
  });

  it.each([[1, 1, "1 guest · 1 service"], [2, 1, "2 guests · 1 service"], [2, 2, "2 guests · 2 services"]])(
    "pluralizes %i guests and %i services", (guests, services, expected) => {
      expect(getUserMessages("en").receptionist.waitlist.groupRequest(guests, services)).toBe(expected);
    },
  );

  it("uses plain Vietnamese without claiming delivery", () => {
    const t = getUserMessages("vi").receptionist.waitlist;
    expect(t.deliveryStatus.sent).toBe("Đơn vị gửi đã nhận");
    expect(t.deliveryStatus.sent).not.toBe(t.deliveryStatus.delivered);
    for (const label of [t.statusLabel, t.joinedAtLabel, t.sourceLabel]) {
      expect(label).not.toMatch(/Waitlist|Provider/i);
    }
  });
});
