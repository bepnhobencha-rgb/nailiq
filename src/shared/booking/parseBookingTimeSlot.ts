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
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM" && hour !== 12) {
    hour += 12;
  } else if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }
  return hour * 60 + minute;
}

/**
 * Parses booking UI labels like "9:00 AM" into a Date on the given YYYY-MM-DD (local).
 */
export function parseTimeSlotOnDate(timeSlot: string, dateYmd: string): Date {
  const trimmed = timeSlot.trim();
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(trimmed);
  if (!match) {
    throw new Error("invalid_time_slot");
  }
  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
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
