/**
 * "Add to calendar" helpers for the booking confirmation email — a one-tap way
 * to drop the appointment into the customer's phone calendar (a real no-show
 * reducer). We give BOTH:
 *  - a Google Calendar template link (Gmail / Android), and
 *  - an .ics attachment (Apple Mail / Outlook auto-detect → "Add to Calendar").
 */

type CalEvent = {
  title: string;
  startUtc: string; // ISO
  endUtc: string;   // ISO
  location?: string | null;
  details?: string | null;
};

/** ISO → iCal UTC stamp "YYYYMMDDTHHMMSSZ". Returns null on bad input. */
function icalStamp(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Escape per RFC 5545 (commas, semicolons, backslashes, newlines). */
function icalEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Google Calendar "add event" template URL, or null if dates are invalid. */
export function googleCalendarUrl(ev: CalEvent): string | null {
  const s = icalStamp(ev.startUtc);
  const e = icalStamp(ev.endUtc);
  if (!s || !e) return null;
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title,
    dates: `${s}/${e}`,
  });
  if (ev.location) p.set("location", ev.location);
  if (ev.details) p.set("details", ev.details);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/** RFC 5545 .ics content for a single event, or null if dates are invalid. */
export function buildIcs(ev: CalEvent & { uid: string }): string | null {
  const s = icalStamp(ev.startUtc);
  const e = icalStamp(ev.endUtc);
  const now = icalStamp(new Date().toISOString());
  if (!s || !e || !now) return null;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NailIQ//Booking//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${s}`,
    `DTEND:${e}`,
    `SUMMARY:${icalEscape(ev.title)}`,
    ev.location ? `LOCATION:${icalEscape(ev.location)}` : "",
    ev.details ? `DESCRIPTION:${icalEscape(ev.details)}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.join("\r\n");
}
