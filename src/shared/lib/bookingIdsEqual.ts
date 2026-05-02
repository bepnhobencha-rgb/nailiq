/** Stable compare for Supabase UUID / text ids (Realtime vs join select). */
export function bookingIdsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  const na = String(a).trim().toLowerCase();
  const nb = String(b).trim().toLowerCase();
  return na.length > 0 && na === nb;
}
