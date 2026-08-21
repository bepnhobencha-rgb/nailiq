/**
 * Demo cookies and demo-OTP registrations are restricted to this slug —
 * never grants access to real-tenant data. Normal production configuration
 * keeps demo OTP off; the test-only pin bypass additionally refuses production
 * even if a demo flag is copied there by mistake.
 */
export const DEMO_SALON_SLUG = "demo-salon";

/**
 * Environment inputs that decide whether the test-only slug-pin bypass is
 * safe. Kept structural and pure so the complete deployment matrix can be
 * tested without mutating process state.
 */
export type DemoOtpEnvironment = {
  NODE_ENV?: string;
  CI?: string;
  GITHUB_ACTIONS?: string;
  VERCEL?: string;
  VERCEL_ENV?: string;
  DEMO_OTP?: string;
  NEXT_PUBLIC_DEMO_OTP?: string;
  NAILIQ_TEST_BYPASS_SLUG_PIN?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  /** Exact 20-character project ref explicitly dedicated to this E2E run. */
  E2E_EXPECTED_PROJECT_REF?: string;
  NEXT_PUBLIC_SITE_URL?: string;
  BASE_URL?: string;
  PLAYWRIGHT_BASE_URL?: string;
};

/** NailIQ projects whose data must never be exposed through an E2E cookie. */
const PRODUCTION_SUPABASE_PROJECT_REFS: readonly string[] = [
  "fshmobzyjhmtvndobwsy",
];

/** NailIQ hosts that identify a production request even outside Vercel. */
const PRODUCTION_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)nailiq\.ca$/i,
  /(^|\.)nailiq\.vercel\.app$/i,
];

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
 * - Regardless of the toggle, production runtime/host/project signals force
 *   demo off. Remote test projects must match `E2E_EXPECTED_PROJECT_REF`.
 */
export function isDemoOtpRuntime(
  env: DemoOtpEnvironment = process.env,
): boolean {
  let configured = false;
  if (
    normalizeDemoOtpEnv(env.DEMO_OTP) ||
    normalizeDemoOtpEnv(env.NEXT_PUBLIC_DEMO_OTP)
  ) {
    configured = true;
  } else if (
    normalizeDemoOtpDisabled(env.DEMO_OTP) ||
    normalizeDemoOtpDisabled(env.NEXT_PUBLIC_DEMO_OTP)
  ) {
    return false;
  } else {
    configured = env.NODE_ENV === "development";
  }

  if (!configured || isProductionRuntime(env)) return false;
  return isRecognizedNonProductionProject(env);
}

function normalizedEnv(raw: string | undefined): string {
  if (raw == null) return "";
  return raw
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim()
    .toLowerCase();
}

function supabaseProjectRef(rawUrl: string | undefined): string | null {
  if (!rawUrl?.trim()) return null;
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.(?:co|in)$/i.exec(
    rawUrl.trim().replace(/\/+$/, ""),
  );
  return match ? match[1].toLowerCase() : null;
}

function isLocalUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl?.trim()) return false;
  try {
    const host = new URL(rawUrl.trim()).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function isProductionHost(rawUrl: string | undefined): boolean {
  if (!rawUrl?.trim()) return false;
  try {
    const host = new URL(rawUrl.trim()).hostname;
    return PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
}

/**
 * Positive identification of a target that E2E may use. A missing or
 * unrecognisable Supabase URL fails closed because the bypass ultimately leads
 * to a service-role client, which bypasses RLS.
 */
function isRecognizedNonProductionProject(env: DemoOtpEnvironment): boolean {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const projectRef = supabaseProjectRef(url);
  const expectedProjectRef = normalizedEnv(env.E2E_EXPECTED_PROJECT_REF);

  if (
    projectRef &&
    PRODUCTION_SUPABASE_PROJECT_REFS.includes(projectRef)
  ) {
    return false;
  }

  // The checked-in CI workflow uses a throwaway loopback Supabase stack.
  if (isLocalUrl(url)) return true;

  // A hosted URL is never trusted merely because its ref looks syntactically
  // valid. It must match the same explicit pin used by the E2E production
  // guard, otherwise an unknown (possibly customer-bearing) project could be
  // blessed by copying the bypass flag into a preview/local environment.
  return (
    projectRef !== null &&
    /^[a-z0-9]{20}$/.test(expectedProjectRef) &&
    projectRef === expectedProjectRef
  );
}

function isProductionRuntime(env: DemoOtpEnvironment): boolean {
  const vercelEnv = normalizedEnv(env.VERCEL_ENV);
  if (vercelEnv === "production") return true;

  if (
    [
      env.NEXT_PUBLIC_SITE_URL,
      env.BASE_URL,
      env.PLAYWRIGHT_BASE_URL,
    ].some(isProductionHost)
  ) {
    return true;
  }

  if (env.NODE_ENV !== "production" || vercelEnv === "preview") return false;

  // The checked-in GitHub E2E workflow legitimately uses `next start`. Treat
  // that one production *build* as non-production only when both GitHub's
  // runner identity and localhost app target are present and Vercel is absent.
  const appTargets = [
    env.NEXT_PUBLIC_SITE_URL,
    env.BASE_URL,
    env.PLAYWRIGHT_BASE_URL,
  ].filter((value): value is string => Boolean(value?.trim()));
  const isolatedGitHubE2E =
    normalizedEnv(env.CI) === "true" &&
    normalizedEnv(env.GITHUB_ACTIONS) === "true" &&
    !normalizedEnv(env.VERCEL) &&
    appTargets.length > 0 &&
    appTargets.every(isLocalUrl);

  return !isolatedGitHubE2E;
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
 * sole purpose is exercising the test suite. A loopback Supabase stack or an
 * explicitly pinned non-production project is required; production
 * runtime/host/project signals always win.
 *
 * Callers: `src/proxy.ts`, `getSalonViaDemoCookie` and the demo
 * branches in `setupActions.ts` (`writableSupabase`, `verifyDemoSetupSlug`).
 */
export function isDemoSlugPinBypassed(
  env: DemoOtpEnvironment = process.env,
): boolean {
  if (env.NAILIQ_TEST_BYPASS_SLUG_PIN !== "1") return false;
  return isDemoOtpRuntime(env);
}
