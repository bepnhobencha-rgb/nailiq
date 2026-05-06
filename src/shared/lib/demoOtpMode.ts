/**
 * Demo cookies and demo-OTP registrations are restricted to this slug —
 * never grants access to real-tenant data. In production demo is fully off
 * (`isDemoOtpRuntime()` returns false) so this constant is inert.
 */
export const DEMO_SALON_SLUG = "demo-salon";

/** Trims stray quotes/spaces — Vercel env values sometimes include wrapping quotes */
export function normalizeDemoOtpEnv(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
    .toLowerCase();
  return v === "true" || v === "1";
}

/** Explicitly disables demo OTP when env is set to false/0 */
function normalizeDemoOtpDisabled(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
    .toLowerCase();
  return v === "false" || v === "0";
}

/**
 * Demo OTP (no real SMS — codes from DB modal / logs):
 * - `DEMO_OTP=true` or `NEXT_PUBLIC_DEMO_OTP=true` → demo on (also Vercel runtime toggle).
 * - `DEMO_OTP=false` / `NEXT_PUBLIC_DEMO_OTP=false` → demo off (real SMS).
 * - Neither set → **development defaults to demo**; production defaults to real SMS.
 */
export function isDemoOtpRuntime(): boolean {
  if (
    normalizeDemoOtpEnv(process.env.DEMO_OTP) ||
    normalizeDemoOtpEnv(process.env.NEXT_PUBLIC_DEMO_OTP)
  ) {
    return true;
  }
  if (
    normalizeDemoOtpDisabled(process.env.DEMO_OTP) ||
    normalizeDemoOtpDisabled(process.env.NEXT_PUBLIC_DEMO_OTP)
  ) {
    return false;
  }
  return process.env.NODE_ENV === "development";
}

/**
 * 🚨 DANGER: never set `NAILIQ_TEST_BYPASS_SLUG_PIN=1` on Vercel production
 * environment.
 *
 * This flag exists ONLY for E2E tests (Playwright) so they can use
 * non-`demo-salon` slugs (e.g. `e2e-receptionist-center`) with the demo
 * cookie. Production MUST enforce the `DEMO_SALON_SLUG` pin — otherwise
 * the cookie can be abused to access any tenant's dashboard by setting
 * `nailiq-demo-slug` to that tenant's slug.
 *
 * Allowed environments: local dev, CI/E2E runners, preview deploys whose
 * sole purpose is exercising the test suite. Never on `production`.
 *
 * Callers: `src/middleware.ts`, `getSalonViaDemoCookie` and the demo
 * branches in `setupActions.ts` (`writableSupabase`, `verifyDemoSetupSlug`).
 */
export function isDemoSlugPinBypassed(): boolean {
  return process.env.NAILIQ_TEST_BYPASS_SLUG_PIN === "1";
}

