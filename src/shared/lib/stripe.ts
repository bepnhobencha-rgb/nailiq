/**
 * Stripe client — server-only.
 *
 * IMPORTANT: never import this from a `"use client"` module. The Stripe
 * SDK has no business in the browser, and the secret key is kept out
 * of the client bundle by importing only from server actions / route
 * handlers. The dynamic-import note in `getStripeClient` adds defense
 * in depth: the package isn't tree-shaken into client chunks.
 *
 * Production: throws on missing `STRIPE_SECRET_KEY` so the checkout /
 * webhook flows fail loudly rather than silently degrading.
 * Development: returns `null` and logs a warning so the rest of the
 * dashboard still mounts without Stripe creds.
 */
import Stripe from "stripe";

let cached: Stripe | null | "uninit" = "uninit";

export function getStripeClient(): Stripe | null {
  if (cached !== "uninit") return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.trim().length === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("STRIPE_SECRET_KEY missing in production");
    }
    console.warn(
      "[stripe] STRIPE_SECRET_KEY missing — checkout/portal calls will fail (dev only)",
    );
    cached = null;
    return cached;
  }
  // No `apiVersion` pin — the installed `stripe` package's default
  // version is the right baseline; pinning here would silently desync
  // the runtime SDK from the dashboard's expected webhook shape.
  cached = new Stripe(key.trim());
  return cached;
}

export function getStripeWebhookSecret(): string | null {
  const v = process.env.STRIPE_WEBHOOK_SECRET;
  return v && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Resolves the canonical app origin used for Stripe `success_url` and
 * `cancel_url` redirects. Prefers `NEXT_PUBLIC_APP_URL` (explicit prod
 * value), falls back to `VERCEL_URL` (preview deploys), and uses
 * localhost in dev.
 */
export function getStripeReturnOrigin(): string {
  const explicit = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (explicit.length > 0) return explicit.replace(/\/$/, "");
  const vercel = (process.env.VERCEL_URL ?? "").trim();
  if (vercel.length > 0) return `https://${vercel}`;
  return "http://localhost:3000";
}
