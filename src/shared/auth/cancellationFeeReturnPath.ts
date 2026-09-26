/** A navigation hint only. The destination must recheck salon membership and role. */
export function cancellationFeeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 180) return null;
  // Deliberately allow exactly one read-only page, with no query, fragment,
  // escaping, credentials, or alternate origin. Never accept arbitrary `next`.
  return /^\/dashboard\/[a-z0-9][a-z0-9-]{0,63}\/cancellation-fee\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}

export function withCancellationFeeReturnPath(path: string, next: unknown): string {
  const safeNext = cancellationFeeReturnPath(next);
  return safeNext
    ? `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(safeNext)}`
    : path;
}
