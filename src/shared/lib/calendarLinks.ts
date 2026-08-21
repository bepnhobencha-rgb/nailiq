/**
 * "Add to calendar" helpers for the booking confirmation email — a one-tap way
 * to drop the appointment into the customer's phone calendar (a real no-show
 * reducer). We give BOTH:
 *  - a Google Calendar template link (Gmail / Android), and
 *  - an .ics attachment (Apple Mail / Outlook auto-detect → "Add to Calendar").
 */

import { canonicalizeStrictRfc3339Instant } from "@/shared/lib/strictRfc3339Instant";

type CalEvent = {
  title: string;
  startUtc: string; // ISO
  endUtc: string;   // ISO
  location?: string | null;
  details?: string | null;
};

const SAFE_ICAL_UID_RE = /^[^\u0000-\u001f\u007f]{1,255}$/;

/** ISO → iCal UTC stamp "YYYYMMDDTHHMMSSZ". Returns null on bad input. */
function icalStamp(iso: string): string | null {
  const canonical = canonicalizeStrictRfc3339Instant(iso);
  return canonical
    ? canonical.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
    : null;
}

function calendarWindow(startUtc: string, endUtc: string): { start: string; end: string } | null {
  const start = icalStamp(startUtc);
  const end = icalStamp(endUtc);
  const startMs = start ? Date.parse(startUtc) : Number.NaN;
  const endMs = end ? Date.parse(endUtc) : Number.NaN;
  return start && end && endMs > startMs ? { start, end } : null;
}

/** Escape per RFC 5545 (commas, semicolons, backslashes, newlines). */
function icalEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Google Calendar "add event" template URL, or null if dates are invalid. */
export function googleCalendarUrl(ev: CalEvent): string | null {
  const window = calendarWindow(ev.startUtc, ev.endUtc);
  if (!window) return null;
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title,
    dates: `${window.start}/${window.end}`,
  });
  if (ev.location) p.set("location", ev.location);
  if (ev.details) p.set("details", ev.details);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/** RFC 5545 .ics content for a single event, or null if dates are invalid. */
export function buildIcs(ev: CalEvent & { uid: string }): string | null {
  const window = calendarWindow(ev.startUtc, ev.endUtc);
  const now = icalStamp(new Date().toISOString());
  const uid = ev.uid.trim();
  if (!window || !now || !SAFE_ICAL_UID_RE.test(uid)) return null;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NailIQ//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icalEscape(uid)}`,
    `DTSTAMP:${now}`,
    `DTSTART:${window.start}`,
    `DTEND:${window.end}`,
    `SUMMARY:${icalEscape(ev.title)}`,
    ev.location ? `LOCATION:${icalEscape(ev.location)}` : "",
    ev.details ? `DESCRIPTION:${icalEscape(ev.details)}` : "",
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.join("\r\n");
}
