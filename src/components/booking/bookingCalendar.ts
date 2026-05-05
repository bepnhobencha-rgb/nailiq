function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function utcToIcsUtc(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function generateBookingCalendarIcs(args: {
  title: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  eventUid: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "PRODID:-//NailIQ//Public Booking//EN",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(args.eventUid)}`,
    `DTSTAMP:${utcToIcsUtc(new Date())}`,
    `DTSTART:${utcToIcsUtc(args.start)}`,
    `DTEND:${utcToIcsUtc(args.end)}`,
    `SUMMARY:${escapeIcsText(args.title)}`,
    `DESCRIPTION:${escapeIcsText(args.description)}`,
    `LOCATION:${escapeIcsText(args.location)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}
