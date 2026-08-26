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
