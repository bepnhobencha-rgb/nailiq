import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * SuperAdmin membership check (Huy-only internal panel).
 *
 * Source of truth = `public.superadmins` table. We use the service-role
 * client so the lookup works regardless of the caller's RLS context
 * (we don't want a forgotten policy hiding rows from this gate).
 *
 * Cached for 5 minutes per `userId` in a process-local Map. SuperAdmin
 * membership rarely changes; skipping the DB hit on every request keeps
 * the panel and its server actions snappy.
 *
 * Fail-safe: any error (missing table, network blip, malformed env)
 * resolves to `false`. We'd rather lock Huy out for a minute than
 * silently grant SuperAdmin to anyone.
 */

const TTL_MS = 5 * 60 * 1_000;

type CacheEntry = {
  value: boolean;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

export async function isSuperAdmin(userId: string): Promise<boolean> {
  const id = userId.trim();
  if (!id) return false;

  const cached = cache.get(id);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let admin;
  try {
    admin = createServiceRoleClient();
  } catch {
    return false;
  }

  try {
    const { data, error } = await admin
      .from("superadmins")
      .select("user_id")
      .eq("user_id", id)
      .maybeSingle();

    if (error) {
      // Table missing / migration not applied / network — fail safe.
      console.error("[isSuperAdmin] lookup failed", error);
      return false;
    }

    const value = Boolean(data?.user_id);
    cache.set(id, { value, expiresAt: now + TTL_MS });
    return value;
  } catch (err) {
    console.error("[isSuperAdmin] unexpected", err);
    return false;
  }
}

/**
 * Test-only / SuperAdmin-action-only escape hatch. Call after granting
 * or revoking SuperAdmin membership so the next request sees the
 * change without waiting out the 5-minute TTL.
 */
export function clearSuperAdminCache(userId?: string): void {
  if (userId) {
    cache.delete(userId.trim());
  } else {
    cache.clear();
  }
}
