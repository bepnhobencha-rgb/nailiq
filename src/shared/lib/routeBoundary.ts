/**
 * Path matching that respects segment boundaries.
 *
 * `pathname.startsWith("/dashboard")` looks like it asks "is this the dashboard?"
 * It actually asks "does this path happen to begin with those ten characters?" —
 * and so it also swallows `/dashboard-abc`, `/dashboard-salon`, `/dashboard123`.
 *
 * Those are not internal routes. They are legal salon slugs: RESERVED_BOOKING_SLUGS
 * reserves the exact word "dashboard", not the prefix, so a salon can and does
 * register `dashboard-nails`. Its public booking page was then caught by the
 * dashboard auth gate and 307'd to /login — the salon's own customers could not
 * reach it, and nothing in the logs looked like an error.
 *
 * A URL path is a list of segments separated by "/". "Under /dashboard" therefore
 * means the path IS "/dashboard", or it continues with a "/". That is the whole
 * rule, and this is what writing it down looks like.
 */
export function isRouteOrUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** True when `pathname` is at, or under, ANY of `bases`. */
export function isRouteOrUnderAny(
  pathname: string,
  bases: readonly string[],
): boolean {
  return bases.some((base) => isRouteOrUnder(pathname, base));
}
