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
  /** POST from /contact form (public marketing inquiry). Create the
   *  matching rule in Vercel WAF with a low ceiling — e.g. 5 submissions
   *  per IP per hour — since this is unauthenticated and prone to spam.
   *  Fail-open until the rule exists. */
  contactSubmit: "contact-submit",
  /** GET /api/customer/[phone] — returning-customer lookup. Public + unauth,
   *  so it's a PII-enumeration target. Pair with a Vercel WAF rule at a low
   *  ceiling (e.g. 20/min per IP) — legit booking only calls it a few times. */
  customerLookup: "customer-lookup",
  /** POST /api/booking/{square-save-card,stripe-setup-intent} — anon card-on-file
   *  endpoints. No charge happens, but they hit the payment provider, so an
   *  attacker with a booking id could card-test against them. Pair with a Vercel
   *  WAF rule keyed by IP+bookingId at a low ceiling (e.g. 5/min) — a real
   *  customer saves a card once. */
  cardSave: "card-save",
} as const;

export type RateLimitId = (typeof RATE_LIMIT_IDS)[keyof typeof RATE_LIMIT_IDS];

// A missing programmatic firewall rule is stable for a short interval and the
// SDK otherwise performs an internal HTTP lookup for every request. Cache only
// the negative "not-found" result, briefly and per warm process. Configured
// rules, blocked requests, SDK failures and all durable application limiters
// remain unaffected.
const NOT_FOUND_CACHE_TTL_MS = 10_000;
const missingRuleUntil = new Map<RateLimitId, number>();

/**
 * Check a rate limit by ID. Returns `true` when the caller should be
 * blocked (HTTP 429). Returns `false` when the request is allowed —
 * including when the rule isn't configured (fail-open).
 *
 * Fail-open is intentional: an outage in the WAF lookup should never
 * block the booking flow. The matching firewall rule itself is the
 * primary defence; this hook is the secondary signal for code paths
 * that want to react (e.g. log a NailIQ Error Monitor breadcrumb, swap copy).
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
  const now = Date.now();
  const cachedUntil = missingRuleUntil.get(id) ?? 0;
  if (cachedUntil > now) return false;
  if (cachedUntil > 0) missingRuleUntil.delete(id);

  try {
    const { rateLimited, error } = await checkRateLimit(id, {
      request: options.request,
      headers: options.headers,
      rateLimitKey: options.rateLimitKey,
    });
    if (error === "not-found") {
      missingRuleUntil.set(id, now + NOT_FOUND_CACHE_TTL_MS);
    }
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
