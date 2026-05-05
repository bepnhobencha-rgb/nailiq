/** Hides auto-generated placeholders ("Staff 1", "staff 2", empty) on public surfaces. */
const PLACEHOLDER_NAME_RE = /^staff\s+\d+$/i;

export function isPlaceholderStaffName(raw: string | null | undefined): boolean {
  const t = (raw ?? "").trim();
  if (t.length === 0) return true;
  return PLACEHOLDER_NAME_RE.test(t);
}

/**
 * Returns the staff name to render on the public booking surface, or the
 * supplied placeholder fallback when the DB row still has an auto-generated
 * "Staff N" / empty value. The DB stays untouched.
 */
export function getPublicStaffDisplayName(
  raw: string | null | undefined,
  placeholder: string,
): string {
  if (isPlaceholderStaffName(raw)) return placeholder;
  return (raw ?? "").trim();
}
