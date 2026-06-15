/**
 * Device-local `YYYY-MM-DD` ↔ `Date` helpers for calendar-grid layout and
 * `<input type="date">` math.
 *
 * These intentionally operate in the DEVICE's local timezone, not the salon's:
 * they drive month/week grid cell positioning and date-picker values, which are
 * inherently device-local. For salon-timezone day math (booking day keys,
 * "today" in the salon's tz) use `salonTime.ts` instead.
 *
 * Previously copy-pasted verbatim in MonthView, WeekView, DeskBookingForm and
 * EditBookingForm — consolidated here so the parse/format convention is one place.
 */

/** Parse `YYYY-MM-DD` to a local `Date` at midnight. */
export function ymdToLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Parse `YYYY-MM-DD` to a local `Date` at NOON (avoids DST midnight edge cases
 *  when the value is only used as a stable day anchor). */
export function ymdToLocalNoon(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
}

/** Format a local `Date` back to `YYYY-MM-DD`. */
export function localDateToYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
