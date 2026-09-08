import { describe, expect, it } from "vitest";

import { checkWalkinWithinOpeningHours } from "../walkinOpeningHours";

const HOURS = {
  mon: { open: "09:00", close: "18:00", closed: false },
  tue: { open: "09:00", close: "18:00", closed: false },
  wed: { open: "09:00", close: "18:00", closed: false },
  thu: { open: "09:00", close: "18:00", closed: false },
  fri: { open: "09:00", close: "18:00", closed: false },
  sat: { open: "09:00", close: "18:00", closed: false },
  sun: { open: "09:00", close: "18:00", closed: true },
};

describe("checkWalkinWithinOpeningHours", () => {
  it("blocks a walk-in on the salon's closed weekday", () => {
    expect(
      checkWalkinWithinOpeningHours({
        openingHoursRaw: HOURS,
        timezone: "America/Vancouver",
        actualArrivalAtIso: "2026-09-06T20:30:00.000Z",
        serviceDurationMinutes: 25,
      }),
    ).toEqual({ ok: false, reason: "closed_day" });
  });

  it("allows a service that completes during open hours", () => {
    expect(
      checkWalkinWithinOpeningHours({
        openingHoursRaw: HOURS,
        timezone: "America/Vancouver",
        actualArrivalAtIso: "2026-09-07T16:00:00.000Z",
        serviceDurationMinutes: 25,
      }),
    ).toEqual({ ok: true });
  });

  it("blocks a walk-in whose service would finish after close", () => {
    expect(
      checkWalkinWithinOpeningHours({
        openingHoursRaw: HOURS,
        timezone: "America/Vancouver",
        actualArrivalAtIso: "2026-09-08T00:45:00.000Z",
        serviceDurationMinutes: 30,
      }),
    ).toEqual({ ok: false, reason: "outside_hours" });
  });

  it("honors an explicit salon closure date", () => {
    expect(
      checkWalkinWithinOpeningHours({
        openingHoursRaw: HOURS,
        bookingClosedDatesRaw: ["2026-09-07"],
        timezone: "America/Vancouver",
        actualArrivalAtIso: "2026-09-07T16:00:00.000Z",
        serviceDurationMinutes: 25,
      }),
    ).toEqual({ ok: false, reason: "closed_day" });
  });

  it("fails closed when the salon timezone cannot be verified", () => {
    expect(
      checkWalkinWithinOpeningHours({
        openingHoursRaw: HOURS,
        timezone: "Invalid/Timezone",
        actualArrivalAtIso: "2026-09-07T16:00:00.000Z",
        serviceDurationMinutes: 25,
      }),
    ).toEqual({ ok: false, reason: "invalid_hours" });
  });
});
