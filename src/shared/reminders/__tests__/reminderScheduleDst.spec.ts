import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { buildIcs, googleCalendarUrl } from "@/shared/lib/calendarLinks";
import { formatReminderTimeLabel, reminderDueWindows } from "../reminderSchedule";

const VANCOUVER = "America/Vancouver";

describe("reminder and calendar DST contract", () => {
  it("keeps the cron worker on the shared UTC-window and offset-labelled path", () => {
    const route = fs.readFileSync(
      path.join(process.cwd(), "src/app/api/cron/reminders/route.ts"),
      "utf8",
    );
    expect(route).toContain("const dueWindows = reminderDueWindows(now)");
    expect(route).toContain("formatReminderTimeLabel(");
    expect(route).not.toContain("23.75 * 60 * 60");
  });

  it("selects 24h/3h by elapsed UTC duration across spring-forward", () => {
    const windows = reminderDueWindows("2026-03-07T10:30:00.000Z");
    expect(windows).toEqual({
      reminder24h: {
        startUtc: "2026-03-08T10:15:00.000Z",
        endUtc: "2026-03-08T10:45:00.000Z",
      },
      reminder3h: {
        startUtc: "2026-03-07T13:15:00.000Z",
        endUtc: "2026-03-07T13:45:00.000Z",
      },
    });
    expect(formatReminderTimeLabel("2026-03-08T10:30:00.000Z", VANCOUVER)).toBe(
      "3:30 AM PDT",
    );
  });

  it("distinguishes both repeated fall-back wall times in SMS copy", () => {
    expect(formatReminderTimeLabel("2026-11-01T08:30:00.000Z", VANCOUVER)).toBe(
      "1:30 AM PDT",
    );
    expect(formatReminderTimeLabel("2026-11-01T09:30:00.000Z", VANCOUVER)).toBe(
      "1:30 AM PST",
    );
  });

  it("keeps 24h and 3h windows on elapsed time across fall-back", () => {
    expect(reminderDueWindows("2026-10-31T09:30:00.000Z").reminder24h).toEqual({
      startUtc: "2026-11-01T09:15:00.000Z",
      endUtc: "2026-11-01T09:45:00.000Z",
    });
    expect(reminderDueWindows("2026-11-01T06:30:00.000Z").reminder3h).toEqual({
      startUtc: "2026-11-01T09:15:00.000Z",
      endUtc: "2026-11-01T09:45:00.000Z",
    });
  });

  it("crosses the year boundary without resetting reminder windows", () => {
    expect(reminderDueWindows("2026-12-31T23:55:00.000Z")).toEqual({
      reminder24h: {
        startUtc: "2027-01-01T23:40:00.000Z",
        endUtc: "2027-01-02T00:10:00.000Z",
      },
      reminder3h: {
        startUtc: "2027-01-01T02:40:00.000Z",
        endUtc: "2027-01-01T03:10:00.000Z",
      },
    });
  });

  it("produces identical windows for Date, epoch and explicit-offset inputs", () => {
    const iso = "2026-11-01T09:30:00.000Z";
    const expected = reminderDueWindows(iso);
    expect(reminderDueWindows(new Date(iso))).toEqual(expected);
    expect(reminderDueWindows(Date.parse(iso))).toEqual(expected);
    expect(reminderDueWindows("2026-11-01T01:30:00-08:00")).toEqual(expected);
  });

  it("keeps a fifteen-minute overlap between adjacent worker runs", () => {
    const first = reminderDueWindows("2026-09-25T00:00:00.000Z");
    const next = reminderDueWindows("2026-09-25T00:15:00.000Z");
    for (const kind of ["reminder24h", "reminder3h"] as const) {
      expect(Date.parse(first[kind].endUtc) - Date.parse(next[kind].startUtc)).toBe(15 * 60_000);
    }
    // Window overlap is intentional; durable claims, not this pure selector,
    // are responsible for preventing duplicate sends.
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, new Date(Number.NaN)])(
    "rejects invalid numeric or Date scheduler input (%s)",
    (value) => {
      expect(() => reminderDueWindows(value)).toThrow("invalid instant");
    },
  );

  it("keeps Google and ICS events on authoritative UTC instants across DST", () => {
    const event = {
      uid: "dst-booking-1@nailiq.ca",
      title: "Nail appointment",
      startUtc: "2026-11-01T08:30:00.000Z",
      endUtc: "2026-11-01T10:00:00.000Z",
      location: "Vancouver, BC",
    };
    const url = googleCalendarUrl(event);
    expect(url).not.toBeNull();
    const params = new URL(url!).searchParams;
    expect(params.get("dates")).toBe("20261101T083000Z/20261101T100000Z");

    const ics = buildIcs(event);
    expect(ics).toContain("DTSTART:20261101T083000Z");
    expect(ics).toContain("DTEND:20261101T100000Z");
  });

  it("fails closed on invalid scheduler instants", () => {
    expect(() => reminderDueWindows("not-an-instant")).toThrow("invalid instant");
    expect(() => formatReminderTimeLabel("not-an-instant", VANCOUVER)).toThrow(
      "invalid start instant",
    );
  });
});
