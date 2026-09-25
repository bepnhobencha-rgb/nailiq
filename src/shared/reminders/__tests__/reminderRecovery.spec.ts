import { describe, expect, it } from "vitest";
import { formatReminderAppointmentLabel, isReminderRecoveryDue, reminderRecoveryStart } from "../reminderSchedule";

describe.each(["24h", "3h"] as const)("recovery window %s", (kind) => {
  const start = "2026-11-01T09:30:00.000Z";
  const nominal = Date.parse(start) - (kind === "24h" ? 24 : 3) * 3_600_000;
  it.each([[-1, false], [0, false], [15, false], [15.01, true], [30, true], [60, true], [60.01, false]])(
    "lateness %s minutes eligible=%s across DST", (minutes, eligible) => {
      expect(isReminderRecoveryDue(start, kind, nominal + Number(minutes) * 60_000)).toBe(eligible);
    },
  );
  it("uses nominal due time, not the last normal cron window", () => {
    expect(reminderRecoveryStart(nominal + 3_600_000, kind)).toBe(start);
  });
  it("never recovers an invalid or past appointment", () => {
    expect(isReminderRecoveryDue("invalid", kind, nominal)).toBe(false);
    expect(isReminderRecoveryDue(start, kind, Date.parse(start))).toBe(false);
  });
});
it.each(["en", "vi"] as const)("recovery label carries date, year and offset in %s", (locale) => {
  const first = formatReminderAppointmentLabel("2026-11-01T08:30:00Z", "America/Vancouver", locale);
  const second = formatReminderAppointmentLabel("2026-11-01T09:30:00Z", "America/Vancouver", locale);
  expect(first).toContain("2026"); expect(second).toContain("2026");
  expect(first).not.toBe(second);
});
