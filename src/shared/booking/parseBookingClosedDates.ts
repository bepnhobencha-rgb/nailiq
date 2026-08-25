/**
 * Parses `salons.booking_closed_dates` (jsonb array of YYYY-MM-DD) for guest booking.
 */
export function parseBookingClosedDateSet(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (raw == null) return out;
  if (!Array.isArray(raw)) return out;
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const ymd = x.trim();
    if (isValidBookingClosedDate(ymd)) {
      out.add(ymd);
    }
  }
  return out;
}

/** Strict calendar validation; regex-only checks accepted dates like 2026-99-99. */
export function isValidBookingClosedDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ymd = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function normalizeBookingClosedDateList(dates: unknown): string[] {
  if (!Array.isArray(dates)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dates) {
    if (typeof d !== "string") continue;
    const ymd = d.trim();
    if (!isValidBookingClosedDate(ymd)) continue;
    if (seen.has(ymd)) continue;
    seen.add(ymd);
    out.push(ymd);
    if (out.length > 366) break;
  }
  return out.sort();
}
