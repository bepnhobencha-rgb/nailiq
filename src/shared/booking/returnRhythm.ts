/**
 * Customer return-rhythm cadence — ONE source of truth shared by the booking
 * drawer launchpad (loadBookingCustomerContext) and the Customer 360 pattern
 * card (loadClientProfile360Action), so "comes back every ~N weeks" reads the
 * same everywhere.
 *
 * Cadence = median number of days between a customer's DISTINCT visit days.
 * Counting distinct days (not bookings) means a same-day multi-service / group
 * booking doesn't fake a "0-day rhythm". We need at least 3 visit days to infer
 * a rhythm, and ignore same-day duplicates (gap 0) and lapses > ~6 months.
 */

const DAY_MS = 86_400_000;
/** Need this many distinct visit days before a rhythm is meaningful. */
export const MIN_VISITS_FOR_CADENCE = 3;
/** Ignore gaps longer than this (days) — a re-activation, not the rhythm. */
const MAX_GAP_DAYS = 183;

/** Statuses that represent a real (non-cancelled, committed) visit. */
function isRealVisit(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s !== "" && s !== "cancelled" && s !== "pending";
}

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/**
 * Median days between a customer's distinct visit days. Returns null when
 * there aren't enough real visits (< {@link MIN_VISITS_FOR_CADENCE}) to infer
 * a rhythm. Cancelled/pending rows are excluded.
 */
export function inferReturnCadenceDays(
  visits: { start: string | null | undefined; status?: string | null }[],
): number | null {
  const days = Array.from(
    new Set(
      visits
        .filter((v) => isRealVisit(v.status) && v.start)
        .map((v) => Math.floor(Date.parse(v.start as string) / DAY_MS))
        .filter((n) => Number.isFinite(n)),
    ),
  ).sort((a, b) => a - b);

  if (days.length < MIN_VISITS_FOR_CADENCE) return null;

  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const g = days[i] - days[i - 1];
    if (g >= 1 && g <= MAX_GAP_DAYS) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  return median(gaps);
}
