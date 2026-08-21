import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { generateBookingCalendarIcs } from "@/components/booking/bookingCalendar";
import { buildIcs, googleCalendarUrl } from "@/shared/lib/calendarLinks";

const event = {
  uid: "booking-123@booking.nailiq",
  title: "Appointment",
  startUtc: "2026-11-01T01:30:00-07:00",
  endUtc: "2026-11-01T02:00:00-08:00",
  location: "Vancouver, BC",
};

describe("one-way calendar artifact accuracy", () => {
  it("canonicalizes explicit RFC3339 offsets to authoritative UTC instants", () => {
    const google = googleCalendarUrl(event);
    expect(google).not.toBeNull();
    expect(new URL(google!).searchParams.get("dates")).toBe(
      "20261101T083000Z/20261101T100000Z",
    );

    const ics = buildIcs(event);
    expect(ics).toContain("UID:booking-123@booking.nailiq");
    expect(ics).toContain("DTSTART:20261101T083000Z");
    expect(ics).toContain("DTEND:20261101T100000Z");
    expect(ics).toContain("STATUS:CONFIRMED");
  });

  it.each([
    ["2026-08-20T10:00:00Z", "2026-08-20T10:00:00Z"],
    ["2026-08-20T11:00:00Z", "2026-08-20T10:00:00Z"],
    ["2026-08-20T10:00:00", "2026-08-20T11:00:00Z"],
    ["2026-02-30T10:00:00Z", "2026-02-30T11:00:00Z"],
  ])("fails closed on a non-positive or timezone-free event window", (startUtc, endUtc) => {
    const invalid = { ...event, startUtc, endUtc };
    expect(googleCalendarUrl(invalid)).toBeNull();
    expect(buildIcs(invalid)).toBeNull();
  });

  it("rejects an injected UID and keeps browser downloads on the shared strict builder", () => {
    expect(buildIcs({ ...event, uid: "booking\r\nX-FAKE:1" })).toBeNull();
    expect(
      generateBookingCalendarIcs({
        title: event.title,
        description: "Confirmed booking",
        location: event.location,
        start: new Date(event.startUtc),
        end: new Date(event.endUtc),
        eventUid: event.uid,
      }),
    ).toContain("UID:booking-123@booking.nailiq");
    expect(
      generateBookingCalendarIcs({
        title: event.title,
        description: "Confirmed booking",
        location: event.location,
        start: new Date(event.endUtc),
        end: new Date(event.startUtc),
        eventUid: event.uid,
      }),
    ).toBeNull();
  });

  it("uses booking-stable party UIDs and never fabricates email end times", () => {
    const party = readFileSync(
      resolve(process.cwd(), "src/app/party/[token]/_components/PartyClaimClient.tsx"),
      "utf8",
    );
    const sender = readFileSync(
      resolve(process.cwd(), "src/shared/booking/sendBookingConfirmationEmail.ts"),
      "utf8",
    );

    expect(party).toContain('uid: `${slot.bookingId}@booking.nailiq`');
    expect(party).not.toContain("Date.now()}@nailiq.ca");
    expect(sender).toContain(
      "bookingEndUtc ?? sequenceReceipt?.parentEndTimeUtc ?? null",
    );
    expect(sender).not.toContain("startMsCal + 60 * 60 * 1000");
  });
});
