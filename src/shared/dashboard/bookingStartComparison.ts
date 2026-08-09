/**
 * Compare booking timestamps by instant rather than by their serialized ISO
 * representation. Postgres commonly returns `+00:00` while browser-generated
 * values use `.000Z`; those strings differ even though the appointment time
 * is identical.
 */
export type BookingStartComparison =
  | { ok: true; changed: boolean; previousMs: number; nextMs: number }
  | { ok: false };

export function compareBookingStartInstants(
  previousStartUtc: string,
  nextStartUtc: string,
): BookingStartComparison {
  const previousMs = Date.parse(previousStartUtc);
  const nextMs = Date.parse(nextStartUtc);
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) {
    return { ok: false };
  }
  return {
    ok: true,
    changed: previousMs !== nextMs,
    previousMs,
    nextMs,
  };
}
