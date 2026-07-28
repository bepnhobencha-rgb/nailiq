/** Booking flowchart: slug length bounds (step 2 validation after normalize). */
export const PUBLIC_BOOKING_SLUG_MIN_LEN = 2;
export const PUBLIC_BOOKING_SLUG_MAX_LEN = 60;
const PUBLIC_BOOKING_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/**
 * Booking flowchart step 2 — validate a normalized salon slug.
 *
 * Registration creates lowercase ASCII words joined by single hyphens. Keeping
 * the public route on that same grammar rejects scanner paths such as
 * `wp-config.php` before they can reach Supabase or pollute operating alerts.
 * Reserved application routes are checked separately by the resolver.
 */
export function validatePublicBookingSlug(normalized: string): boolean {
  const len = normalized.length;
  return (
    len >= PUBLIC_BOOKING_SLUG_MIN_LEN &&
    len <= PUBLIC_BOOKING_SLUG_MAX_LEN &&
    PUBLIC_BOOKING_SLUG_PATTERN.test(normalized)
  );
}
