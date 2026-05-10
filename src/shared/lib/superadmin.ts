import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * SuperAdmin membership + role resolution.
 *
 * Source of truth = `public.superadmins` table. Service-role client so
 * the lookup works regardless of the caller's RLS context (we don't
 * want a forgotten policy hiding rows from this gate).
 *
 * Cached for 5 min per `userId` in a process-local Map. SuperAdmin
 * membership rarely changes; skipping the DB hit on every request keeps
 * the panel and its server actions snappy.
 *
 * Fail-safe: any error (missing table, network blip, malformed env)
 * resolves to "not a superadmin." We'd rather lock the operator out
 * for a minute than silently grant access to anyone.
 *
 * Role contract: per `docs/PERMISSION_MATRIX.md` §8.2 the role is one
 * of `founder | ops_admin | support_admin | billing_admin | ai_admin |
 * readonly_analyst`. Rows with non-null `revoked_at` are inert —
 * `isSuperAdmin` returns false and `getSuperAdminRole` returns null.
 */

export const SUPERADMIN_ROLES = [
  "founder",
  "ops_admin",
  "support_admin",
  "billing_admin",
  "ai_admin",
  "readonly_analyst",
] as const;

export type SuperAdminRole = (typeof SUPERADMIN_ROLES)[number];

type SuperadminRow = {
  role: SuperAdminRole;
  revokedAt: string | null;
};

const TTL_MS = 5 * 60 * 1_000;

type CacheEntry = {
  value: SuperadminRow | null;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

function isKnownRole(input: unknown): input is SuperAdminRole {
  return (
    typeof input === "string" &&
    (SUPERADMIN_ROLES as readonly string[]).includes(input)
  );
}

async function loadSuperadminRow(
  userId: string,
): Promise<SuperadminRow | null> {
  const id = userId.trim();
  if (!id) return null;

  const cached = cache.get(id);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch {
    return null;
  }

  try {
    // Cast: `role` + `revoked_at` columns shipped in migration
    // 20260510220000_superadmin_foundation_1a.sql but
    // lib/database.types.ts is not yet regenerated. Follows the
    // precedent PR #82 set when the table was first introduced.
    const builder = admin.from("superadmins") as unknown as {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{
            data: { role: string; revoked_at: string | null } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };

    const { data, error } = await builder
      .select("role, revoked_at")
      .eq("user_id", id)
      .maybeSingle();

    if (error) {
      // Table missing / migration not applied / network — fail safe.
      console.error("[superadmin] lookup failed", error);
      return null;
    }

    let value: SuperadminRow | null = null;
    if (data && isKnownRole(data.role)) {
      value = {
        role: data.role,
        revokedAt: data.revoked_at,
      };
    } else if (data) {
      // Row exists but role string is unrecognised — treat as inert
      // rather than crash. CHECK constraint on the column should
      // prevent this in practice; this branch is defensive.
      console.error("[superadmin] unknown role", data.role);
    }
    cache.set(id, { value, expiresAt: now + TTL_MS });
    return value;
  } catch (err) {
    console.error("[superadmin] unexpected", err);
    return null;
  }
}

/**
 * Boolean gate: does this user have any active superadmin role?
 *
 * Backwards-compatible with PR #82 call sites. Returns false when the
 * row is missing OR when `revoked_at` is set.
 */
export async function isSuperAdmin(userId: string): Promise<boolean> {
  const row = await loadSuperadminRow(userId);
  return Boolean(row && row.revokedAt === null);
}

/**
 * Resolves the active superadmin role, or null when the caller is not
 * an active superadmin. Use this when the calling code branches on
 * role (routing, UI gating, permission checks per §8.3 of the matrix).
 */
export async function getSuperAdminRole(
  userId: string,
): Promise<SuperAdminRole | null> {
  const row = await loadSuperadminRow(userId);
  if (!row || row.revokedAt !== null) return null;
  return row.role;
}

/**
 * Test-only / mutation-action escape hatch. Call after granting or
 * revoking SuperAdmin membership so the next request sees the change
 * without waiting out the 5-minute TTL.
 */
export function clearSuperAdminCache(userId?: string): void {
  if (userId) {
    cache.delete(userId.trim());
  } else {
    cache.clear();
  }
}
