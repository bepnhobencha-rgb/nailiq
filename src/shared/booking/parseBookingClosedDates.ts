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
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      out.add(ymd);
    }
  }
  return out;
}

export function normalizeBookingClosedDateList(dates: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dates) {
    const ymd = d.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) continue;
    if (seen.has(ymd)) continue;
    seen.add(ymd);
    out.push(ymd);
    if (out.length > 366) break;
  }
  return out.sort();
}
