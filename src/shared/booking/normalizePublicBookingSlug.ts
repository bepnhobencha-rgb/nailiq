/** Booking flowchart: slug length bounds (step 2 validation after normalize). */
export const PUBLIC_BOOKING_SLUG_MIN_LEN = 2;
export const PUBLIC_BOOKING_SLUG_MAX_LEN = 60;

/** Normalize URL segment for matching `salons.slug` (lowercase, trim, decode). */
export function normalizePublicBookingSlug(raw: string): string {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    s = raw;
  }
  return s.trim().toLowerCase();
}

/** Booking flowchart step 2 — validate normalized slug (length only; reserved checked separately). */
export function validatePublicBookingSlug(normalized: string): boolean {
  const len = normalized.length;
  return (
    len >= PUBLIC_BOOKING_SLUG_MIN_LEN &&
    len <= PUBLIC_BOOKING_SLUG_MAX_LEN
  );
}
