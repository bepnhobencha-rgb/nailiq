import "server-only";

import { requireActiveAuthSession } from "@/shared/auth/requireActiveAuthSession";
import { getSuperAdminRole, type SuperAdminRole } from "@/shared/lib/superadmin";
import { createClient } from "@/shared/lib/supabase/server";

type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

export type ActiveSuperAdminSessionResult =
  | {
      ok: true;
      user: { id: string; email?: string | null };
      role: SuperAdminRole;
      supabase: ServerSupabase;
    }
  | {
      ok: false;
      code:
        | "unauthenticated"
        | "session_revoked"
        | "auth_unavailable"
        | "forbidden";
      supabase: ServerSupabase | null;
    };

/**
 * Single fail-closed boundary for privileged SuperAdmin reads and mutations.
 *
 * The active Auth-session proof intentionally runs before the service-role
 * SuperAdmin membership lookup. A revoked session therefore cannot use a
 * cached role entry to reach any privileged data source.
 */
export async function requireActiveSuperAdminSession(): Promise<ActiveSuperAdminSessionResult> {
  let supabase: ServerSupabase;
  try {
    supabase = await createClient();
  } catch {
    return { ok: false, code: "auth_unavailable", supabase: null };
  }

  const session = await requireActiveAuthSession(supabase);
  if (!session.ok) {
    return { ...session, supabase };
  }

  const role = await getSuperAdminRole(session.user.id);
  if (!role) {
    return { ok: false, code: "forbidden", supabase };
  }

  return { ok: true, user: session.user, role, supabase };
}

/** Best-effort cookie/session cleanup before a protected page redirects. */
export async function clearInactiveServerSession(
  supabase: ServerSupabase | null,
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Re-authentication is still enforced by the redirect. Cleanup must never
    // turn an Auth outage into privileged page access or an error disclosure.
  }
}
