/**
 * Production guard for the E2E suite.
 *
 * NailIQ has historically had exactly one Supabase project, so every E2E run
 * seeded rows straight into the production database. That is how five
 * `*.test.invalid` auth users — two of them active `founder` superadmins — and
 * three `e2e-*` fixture salons ended up living in production alongside real
 * salons (see docs/audit/E2E-PRODUCTION-CONTAINMENT.md).
 *
 * This module is the hard stop. It refuses to let the suite touch a database
 * or a host that looks like production.
 *
 * Deliberately NOT based on NODE_ENV: the E2E workflow runs `next start`, so
 * NODE_ENV is legitimately "production" during a perfectly valid test run.
 * NODE_ENV tells us how the app was built, never which database it points at.
 * The Supabase *project ref* is the only trustworthy signal, so that is what
 * we key on.
 *
 * The guard FAILS CLOSED: if it cannot positively identify the target as a
 * non-production project, it throws rather than guessing.
 */

export const FORBIDDEN_MESSAGE =
  "E2E write operations are forbidden against production.";

/** Supabase project refs that must never be written to by tests. */
export const PRODUCTION_PROJECT_REFS: readonly string[] = [
  "fshmobzyjhmtvndobwsy", // NailIQ production
];

/** Hostnames that must never be driven by tests. */
export const PRODUCTION_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)nailiq\.ca$/i,
  /(^|\.)nailiq\.vercel\.app$/i,
];

/** Every test-owned auth user must carry this domain. */
export const E2E_EMAIL_DOMAIN = "nailiq.test.invalid";
/** Every test-owned auth user must carry this prefix. */
export const E2E_EMAIL_PREFIX = "e2e-";
/** Every test-owned salon slug must carry this prefix. */
export const E2E_SLUG_PREFIX = "e2e-";

/**
 * Extract the Supabase project ref from a project URL.
 * `https://abcdefghijklmnopqrst.supabase.co` -> `abcdefghijklmnopqrst`
 * Returns null when the URL is absent or not a Supabase project URL
 * (e.g. a local `http://127.0.0.1:54321` stack).
 */
export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.(co|in)$/i.exec(
    url.trim().replace(/\/+$/, ""),
  );
  return match ? match[1].toLowerCase() : null;
}

/** True when the ref is a known production project. */
export function isProductionProjectRef(ref: string | null): boolean {
  return ref !== null && PRODUCTION_PROJECT_REFS.includes(ref.toLowerCase());
}

/** True when the URL's host is a known production host. */
export function isProductionHost(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  let host: string;
  try {
    host = new URL(url.trim()).hostname;
  } catch {
    return false;
  }
  return PRODUCTION_HOST_PATTERNS.some((re) => re.test(host));
}

/** True for a local Supabase stack (supabase start) — always allowed. */
function isLocalSupabase(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  try {
    const host = new URL(url.trim()).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

export type GuardEnv = {
  supabaseUrl?: string;
  baseUrl?: string;
  serviceRoleKey?: string;
  /** Optional pin: the exact project ref this run is allowed to write to. */
  expectedProjectRef?: string;
};

/**
 * Throw unless `env` unambiguously points at a non-production target.
 * Pure (no process.env access) so it can be unit-tested.
 */
export function assertNotProduction(env: GuardEnv): void {
  const { supabaseUrl, baseUrl, serviceRoleKey, expectedProjectRef } = env;
  const ref = projectRefFromUrl(supabaseUrl);

  // 1. Explicit production project ref.
  if (isProductionProjectRef(ref)) {
    throw new Error(
      `${FORBIDDEN_MESSAGE} NEXT_PUBLIC_SUPABASE_URL points at the production ` +
        `Supabase project (ref: ${ref}). Point it at a dedicated test/staging project.`,
    );
  }

  // 2. Explicit production hostname (either the app under test or the DB URL).
  if (isProductionHost(baseUrl) || isProductionHost(supabaseUrl)) {
    throw new Error(
      `${FORBIDDEN_MESSAGE} The target host is a production host ` +
        `(BASE_URL: ${baseUrl ?? "unset"}). E2E must run against localhost or a staging host.`,
    );
  }

  // 3. Pinned ref mismatch — the run is aimed somewhere it was not meant to go.
  if (expectedProjectRef?.trim() && ref !== expectedProjectRef.trim().toLowerCase()) {
    throw new Error(
      `${FORBIDDEN_MESSAGE} Project ref mismatch: expected ` +
        `"${expectedProjectRef.trim()}" but NEXT_PUBLIC_SUPABASE_URL resolves to "${ref ?? "none"}".`,
    );
  }

  // 4. FAIL CLOSED. Holding a service-role key (which bypasses every RLS policy)
  //    against a project we cannot identify is exactly the situation that caused
  //    the incident. Refuse rather than assume it is safe.
  if (serviceRoleKey?.trim() && ref === null && !isLocalSupabase(supabaseUrl)) {
    throw new Error(
      `${FORBIDDEN_MESSAGE} A SUPABASE_SERVICE_ROLE_KEY is set but ` +
        `NEXT_PUBLIC_SUPABASE_URL ("${supabaseUrl ?? "unset"}") is not a recognisable ` +
        `Supabase project URL. Refusing to run rather than guess which database this is.`,
    );
  }
}

/** Convenience wrapper that reads the ambient environment. */
export function assertNotProductionFromEnv(): void {
  assertNotProduction({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    baseUrl:
      process.env.PLAYWRIGHT_BASE_URL ?? process.env.BASE_URL ?? undefined,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    expectedProjectRef: process.env.E2E_EXPECTED_PROJECT_REF,
  });
}

/** True only for identifiers this suite is allowed to create and delete. */
export function isE2EEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return e.startsWith(E2E_EMAIL_PREFIX) && e.endsWith(`@${E2E_EMAIL_DOMAIN}`);
}

/** True only for salon slugs this suite is allowed to create and delete. */
export function isE2ESlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return slug.trim().toLowerCase().startsWith(E2E_SLUG_PREFIX);
}
