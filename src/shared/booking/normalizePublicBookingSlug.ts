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
