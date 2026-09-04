import { describe, expect, it } from "vitest";

import {
  resolveWalkinActualTime,
  validateWalkinActualTime,
  walkinActualTimeHm,
} from "@/shared/dashboard/walkinActualTime";

describe("walk-in actual-time safety", () => {
  it("accepts now and the oldest minute in the 30-minute UI window", () => {
    const now = "2026-09-04T17:30:45.000Z";
    expect(validateWalkinActualTime(now, now)).toEqual({
      ok: true,
      actualTimeIso: now,
    });
    expect(
      resolveWalkinActualTime("10:00", "America/Los_Angeles", now),
    ).toEqual({
      ok: true,
      actualTimeIso: "2026-09-04T17:00:00.000Z",
    });
  });

  it("rejects older and future wall-clock choices", () => {
    const now = "2026-09-04T17:30:45.000Z";
    expect(
      resolveWalkinActualTime("09:59", "America/Los_Angeles", now),
    ).toEqual({ ok: false, error: "actual_time_too_old" });
    expect(
      resolveWalkinActualTime("10:31", "America/Los_Angeles", now),
    ).toEqual({ ok: false, error: "actual_time_too_old" });
    expect(
      validateWalkinActualTime("2026-09-04T17:31:00.000Z", now),
    ).toEqual({ ok: false, error: "actual_time_in_future" });
  });

  it("resolves a just-before-midnight arrival to the prior salon day", () => {
    expect(
      resolveWalkinActualTime(
        "23:55",
        "America/Los_Angeles",
        "2026-09-05T07:10:00.000Z",
      ),
    ).toEqual({
      ok: true,
      actualTimeIso: "2026-09-05T06:55:00.000Z",
    });
  });

  it("chooses the nearest repeated DST minute", () => {
    expect(
      resolveWalkinActualTime(
        "01:05",
        "America/Vancouver",
        "2026-11-01T09:10:00.000Z",
      ),
    ).toEqual({
      ok: true,
      actualTimeIso: "2026-11-01T09:05:00.000Z",
    });
  });

  it("formats current salon time without depending on device timezone", () => {
    expect(
      walkinActualTimeHm(
        "America/Los_Angeles",
        "2026-09-04T17:30:45.000Z",
      ),
    ).toBe("10:30");
  });
});
