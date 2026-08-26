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

/** True for a local Supabase stack (supabase start). */
function isLocalSupabase(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  try {
    const host = new URL(url.trim()).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Local CLI legacy keys are JWTs issued as `supabase-demo`. Decoding these
 * claims is intentionally only an accidental-production-key guard, not token
 * authentication; the MQA local runner additionally pins the exact key from
 * an independent `supabase status` invocation.
 */
export function isLocalSupabaseServiceRoleKey(key: string | undefined): boolean {
  const parts = key?.trim().split(".") ?? [];
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { iss?: unknown; ref?: unknown; role?: unknown };
    return (
      payload.iss === "supabase-demo" &&
      payload.role === "service_role" &&
      (payload.ref === undefined || payload.ref === "supabase-demo")
    );
  } catch {
    return false;
  }
}

export type GuardEnv = {
  supabaseUrl?: string;
  /** Server-side clients prefer this URL when present. It must be guarded too. */
  internalSupabaseUrl?: string;
  baseUrl?: string;
  serviceRoleKey?: string;
  /** Optional pin: the exact project ref this run is allowed to write to. */
  expectedProjectRef?: string;
  /** Exact local key independently returned by `supabase status`, when known. */
  expectedLocalServiceRoleKey?: string;
};

/**
 * Throw unless `env` unambiguously points at a non-production target.
 * Pure (no process.env access) so it can be unit-tested.
 */
export function assertNotProduction(env: GuardEnv): void {
  const {
    supabaseUrl,
    internalSupabaseUrl,
    baseUrl,
    serviceRoleKey,
    expectedProjectRef,
    expectedLocalServiceRoleKey,
  } = env;
  const targets = [
    { name: "NEXT_PUBLIC_SUPABASE_URL", url: supabaseUrl },
    { name: "SUPABASE_INTERNAL_URL", url: internalSupabaseUrl },
  ].filter((target) => target.url?.trim());
  const refs = targets.map((target) => ({
    ...target,
    ref: projectRefFromUrl(target.url),
  }));

  // 1. Explicit production project ref.
  const productionTarget = refs.find((target) =>
    isProductionProjectRef(target.ref),
  );
  if (productionTarget) {
    throw new Error(
      `${FORBIDDEN_MESSAGE} ${productionTarget.name} points at the production ` +
        `Supabase project (ref: ${productionTarget.ref}). Point it at a dedicated test/staging project.`,
    );
  }

  // 2. Explicit production hostname (either the app under test or the DB URL).
  if (
    isProductionHost(baseUrl) ||
    targets.some((target) => isProductionHost(target.url))
  ) {
    throw new Error(
      `${FORBIDDEN_MESSAGE} The target host is a production host ` +
        `(BASE_URL: ${baseUrl ?? "unset"}). E2E must run against localhost or a staging host.`,
    );
  }

  // 3. A hosted service-role target must always be pinned. Merely recognising a
  // non-production Supabase hostname is not enough: a stale dotenv value could
  // otherwise redirect destructive E2E cleanup to another valid QA project.
  const hostedRefs = refs.filter((target) => target.ref !== null);
  if (
    serviceRoleKey?.trim() &&
    hostedRefs.length > 0 &&
    !expectedProjectRef?.trim()
  ) {
    throw new Error(
      `${FORBIDDEN_MESSAGE} Hosted Supabase E2E requires an exact ` +
        "E2E_EXPECTED_PROJECT_REF pin.",
    );
  }

  // 4. Pinned ref mismatch — the run is aimed somewhere it was not meant to go.
  const normalizedExpectedRef = expectedProjectRef?.trim().toLowerCase();
  const mismatchedTarget = normalizedExpectedRef
    ? refs.find((target) => target.ref !== normalizedExpectedRef) ??
      (refs.length === 0
        ? {
            name: "NEXT_PUBLIC_SUPABASE_URL/SUPABASE_INTERNAL_URL",
            url: undefined,
            ref: null,
          }
        : undefined)
    : undefined;
  if (normalizedExpectedRef && mismatchedTarget) {
    throw new Error(
      `${FORBIDDEN_MESSAGE} Project ref mismatch: expected ` +
        `"${normalizedExpectedRef}" but ${mismatchedTarget.name} resolves to ` +
        `"${mismatchedTarget.ref ?? "none"}".`,
    );
  }

  // 5. A loopback hostname is not proof of a local stack: it may be a tunnel
  // to a hosted project. Reject hosted/opaque keys. Modern non-JWT local keys
  // are accepted only when exactly pinned to independently obtained CLI status.
  const localTargets = refs.filter((target) => isLocalSupabase(target.url));
  if (serviceRoleKey?.trim() && localTargets.length > 0) {
    const exactLocalPin = expectedLocalServiceRoleKey?.trim();
    if (exactLocalPin && serviceRoleKey.trim() !== exactLocalPin) {
      throw new Error(
        `${FORBIDDEN_MESSAGE} The loopback service-role key does not match ` +
          "E2E_EXPECTED_LOCAL_SERVICE_ROLE_KEY from local Supabase status.",
      );
    }
    if (!exactLocalPin && !isLocalSupabaseServiceRoleKey(serviceRoleKey)) {
      throw new Error(
        `${FORBIDDEN_MESSAGE} A loopback Supabase URL requires a local ` +
          "supabase-demo service-role key or an exact independent local-status pin.",
      );
    }
  }

  // 6. FAIL CLOSED. Holding a service-role key (which bypasses every RLS policy)
  //    against a project we cannot identify is exactly the situation that caused
  //    the incident. Refuse rather than assume it is safe.
  const unrecognisedTarget = serviceRoleKey?.trim()
    ? refs.find(
        (target) => target.ref === null && !isLocalSupabase(target.url),
      ) ??
      (refs.length === 0
        ? {
            name: "NEXT_PUBLIC_SUPABASE_URL/SUPABASE_INTERNAL_URL",
            url: undefined,
            ref: null,
          }
        : undefined)
    : undefined;
  if (unrecognisedTarget) {
    throw new Error(
      `${FORBIDDEN_MESSAGE} A SUPABASE_SERVICE_ROLE_KEY is set but ` +
        `${unrecognisedTarget.name} ("${unrecognisedTarget.url ?? "unset"}") is not a recognisable ` +
        `Supabase project URL. Refusing to run rather than guess which database this is.`,
    );
  }
}

/** Convenience wrapper that reads the ambient environment. */
export function assertNotProductionFromEnv(): void {
  assertNotProduction({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    internalSupabaseUrl: process.env.SUPABASE_INTERNAL_URL,
    baseUrl:
      process.env.PLAYWRIGHT_BASE_URL ?? process.env.BASE_URL ?? undefined,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    expectedProjectRef: process.env.E2E_EXPECTED_PROJECT_REF,
    expectedLocalServiceRoleKey:
      process.env.E2E_EXPECTED_LOCAL_SERVICE_ROLE_KEY,
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
