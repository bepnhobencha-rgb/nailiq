/** HttpOnly cookie: grants read-only dashboard access for demo OTP registration (matches one slug). */
export const NAILQ_DEMO_SLUG_COOKIE = "nailiq-demo-slug";

export const NAILQ_DEMO_SLUG_COOKIE_MAX_AGE_S = 60 * 60 * 24;

/**
 * Secure flag for the demo-slug cookie.
 * WebKit (Safari) has no localhost exception for Secure cookies — it refuses to send them
 * over HTTP even for localhost. Chromium has an exception so tests pass there but not on WebKit.
 * We only want Secure when we are actually serving over HTTPS (production), not on CI/localhost.
 */
export const NAILQ_DEMO_SLUG_COOKIE_SECURE =
  process.env.NEXT_PUBLIC_SITE_URL?.startsWith("https://") ?? false;
