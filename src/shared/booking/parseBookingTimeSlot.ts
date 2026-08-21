/**
 * Parses a booking UI label like "9:00 AM" into minutes-from-midnight (0–1439).
 * Timezone-agnostic — the label is a wall-clock time; the caller decides which
 * zone it belongs to (e.g. salon tz via `salonWallTimeToUtcIso`).
 */
export function parseTimeSlotToMinutes(timeSlot: string): number {
  const trimmed = timeSlot.trim();
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(trimmed);
  if (!match) {
    throw new Error("invalid_time_slot");
  }
  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    throw new Error("invalid_time_slot");
  }
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) {
    hour += 12;
  } else if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }
  return hour * 60 + minute;
}

/**
 * Parses booking UI labels like "9:00 AM" into a `Date` on the given YYYY-MM-DD.
 *
 * BROWSER-ONLY — DO NOT CALL FROM THE SERVER. This resolves the wall-clock
 * time using the CALLER'S RUNTIME timezone (`new Date("YYYY-MM-DDTHH:mm:00")`
 * has no offset suffix, so it is parsed in whatever timezone the JS engine
 * itself is running in). In a browser that's the customer's real local
 * timezone, which is what makes this safe for client-only, in-memory use
 * (e.g. an upsell-candidate suggestion that is never persisted). On a server
 * runtime (Vercel/Node is always UTC) the exact same call would silently
 * misinterpret the wall-clock time as UTC, producing a value off by the
 * salon's UTC offset — this caused a real production incident.
 *
 * Server code that needs to turn a salon-local wall-clock time into a UTC
 * instant (e.g. anything that gets persisted) must use
 * `salonWallTimeToUtcIso(dateYmd, minutesFromMidnight, timezone)` from
 * `@/shared/lib/salonTime` instead.
 */
export function parseTimeSlotOnDateInBrowserTz(timeSlot: string, dateYmd: string): Date {
  const trimmed = timeSlot.trim();
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(trimmed);
  if (!match) {
    throw new Error("invalid_time_slot");
  }
  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    throw new Error("invalid_time_slot");
  }
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) {
    hour += 12;
  } else if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const parsed = new Date(`${dateYmd}T${hh}:${mm}:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("invalid_time_slot");
  }
  return parsed;
}
