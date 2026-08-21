export type SameOriginMutationOptions = {
  /** Non-browser API clients carrying their own Bearer credential are not
   * vulnerable to ambient-cookie CSRF. This is intentionally opt-in. */
  allowBearerWithoutCookie?: boolean;
};

/**
 * Shared CSRF fence for cookie-authenticated API mutations.
 *
 * Next.js protects Server Actions by comparing Origin with Host, but ordinary
 * Route Handlers do not receive that framework check. Require an exact origin
 * match before parsing bodies or invoking auth/database code. A credentialed
 * non-browser Bearer request may be allowed only by an explicit caller and only
 * when no Cookie or Origin header is present.
 */
export function isSameOriginMutation(
  request: Request,
  options: SameOriginMutationOptions = {},
): boolean {
  const origin = request.headers.get("origin")?.trim() ?? "";
  const cookie = request.headers.get("cookie")?.trim() ?? "";
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase() ?? "";

  if (
    options.allowBearerWithoutCookie === true &&
    !origin &&
    !cookie &&
    /^Bearer\s+\S+$/i.test(authorization)
  ) {
    return true;
  }

  if (!origin || origin === "null") return false;
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
