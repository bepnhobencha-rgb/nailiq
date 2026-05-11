/**
 * Returns the staff name to render on the public booking surface.
 *
 * Earlier versions of this helper detected auto-generated placeholders
 * ("Staff 1", empty, etc.) and substituted "(Pending)" so customers
 * wouldn't see a half-finished menu. That backfired: salons whose owner
 * deliberately named the row "Staff 1" still saw "(Pending)" on the
 * public page. We now render exactly what the salon set in the DB —
 * the owner is the source of truth.
 */
export function getPublicStaffDisplayName(
  raw: string | null | undefined,
): string {
  return (raw ?? "").trim();
}
