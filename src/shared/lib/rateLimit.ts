/**
 * Task #09-10 — Programmatic rate-limiting hooks against Vercel WAF.
 *
 * `@vercel/firewall.checkRateLimit(id)` looks up the rule with that ID
 * in the project's Vercel Firewall dashboard. If no matching rule
 * exists the call resolves with `rateLimited: false, error: "not-found"`
 * — i.e. a no-op. To actually rate-limit traffic, the project owner
 * must create matching rules in Vercel WAF (see PR #09-10 body for the
 * IDs + suggested thresholds).
 *
 * The package is available on Hobby plan but rate-limiting itself
 * requires Pro. On Hobby the dashboard rules cap out at "log only" so
 * callers see `rateLimited: false` even when the rule matches.
 *
 * Returning a plain boolean keeps callers simple — proxy/middleware
 * handlers just check the value and short-circuit with a 429.
 */

import { checkRateLimit } from "@vercel/firewall";
import type { NextRequest } from "next/server";

/** Rate-limit rule IDs. Keep in sync with the Vercel WAF dashboard. */
export const RATE_LIMIT_IDS = {
  /** POST to /[slug] (booking submission via server action — future) */
  bookingSubmit: "booking-submit",
  /** GET /[slug] page load — anti-scrape on public booking pages */
  bookingPageLoad: "booking-page-load",
  /** POST to /register or /login (auth attempts — future server actions) */
  authAttempt: "auth-attempt",
  /** Future: magic-link / OAuth init endpoints if they get a server wrapper */
  magicLinkSend: "magic-link-send",
} as const;

export type RateLimitId = (typeof RATE_LIMIT_IDS)[keyof typeof RATE_LIMIT_IDS];

/**
 * Check a rate limit by ID. Returns `true` when the caller should be
 * blocked (HTTP 429). Returns `false` when the request is allowed —
 * including when the rule isn't configured (fail-open).
 *
 * Fail-open is intentional: an outage in the WAF lookup should never
 * block the booking flow. The matching firewall rule itself is the
 * primary defence; this hook is the secondary signal for code paths
 * that want to react (e.g. log a Sentry breadcrumb, swap copy).
 */
export async function isRateLimited(
  id: RateLimitId,
  options: {
    request?: NextRequest | Request;
    headers?: Headers;
    /** Override the rate-limit key. Defaults to the caller's IP. */
    rateLimitKey?: string;
  } = {},
): Promise<boolean> {
  try {
    const { rateLimited } = await checkRateLimit(id, {
      request: options.request,
      headers: options.headers,
      rateLimitKey: options.rateLimitKey,
    });
    return rateLimited;
  } catch {
    // Network / SDK failure — fail open. A 429 served by accident is
    // worse than letting one request through.
    return false;
  }
}

/** Convenience wrappers — keep call sites readable. */
export async function checkBookingRateLimit(
  request: NextRequest | Request,
): Promise<boolean> {
  return isRateLimited(RATE_LIMIT_IDS.bookingSubmit, { request });
}

export async function checkBookingPageRateLimit(
  request: NextRequest | Request,
): Promise<boolean> {
  return isRateLimited(RATE_LIMIT_IDS.bookingPageLoad, { request });
}

export async function checkAuthRateLimit(
  request: NextRequest | Request,
): Promise<boolean> {
  return isRateLimited(RATE_LIMIT_IDS.authAttempt, { request });
}

export async function checkMagicLinkRateLimit(
  request: NextRequest | Request,
): Promise<boolean> {
  return isRateLimited(RATE_LIMIT_IDS.magicLinkSend, { request });
}
