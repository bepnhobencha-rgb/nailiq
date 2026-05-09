import { Resend } from "resend";

/**
 * Lazy Resend client.
 *
 * Production: throws on miss so the email flow fails loudly rather than
 * silently dropping verification messages. Development: returns null and
 * logs a warning so devs can iterate the rest of the flow without an
 * API key. Callers should `if (client === null) return ok-without-email`
 * (the underlying mutation should still succeed).
 *
 * The `RESEND_FROM` env var lets ops change the From address without
 * code changes; it falls back to a placeholder that Resend will reject
 * unless the domain is verified — intentional, so a misconfigured prod
 * raises rather than sending from a wildcard.
 */
let cached: Resend | null | "uninit" = "uninit";

export function getResendClient(): Resend | null {
  if (cached !== "uninit") return cached;
  const key = process.env.RESEND_API_KEY;
  if (!key || key.trim().length === 0) {
    if (process.env.NODE_ENV === "production") {
      // In production, missing key is a configuration bug — the email
      // flow has explicit deployment expectations. Log + throw so it
      // surfaces in Sentry rather than silently no-opping.
      throw new Error("RESEND_API_KEY missing in production");
    }
    console.warn(
      "[resend] RESEND_API_KEY missing — email sends will be skipped (dev only)",
    );
    cached = null;
    return cached;
  }
  cached = new Resend(key.trim());
  return cached;
}

export function getResendFrom(): string {
  const v = process.env.RESEND_FROM;
  return v && v.trim().length > 0
    ? v.trim()
    : "NailIQ <noreply@nailiq.invalid>";
}
