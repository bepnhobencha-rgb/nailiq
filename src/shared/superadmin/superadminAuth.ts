"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";

/**
 * Superadmin auth server actions.
 *
 * Distinct from salon-facing auth (OTP / Google OAuth) in two ways:
 *   1. Email + password (no public registration; rows are created
 *      out-of-band by an existing founder).
 *   2. Post-signin role gate — a successful Supabase auth that is
 *      not on `public.superadmins` is signed out immediately and
 *      returned as `no_role`. The caller is told nothing more.
 *
 * Returns are intentionally low-information: `invalid_credentials` and
 * `no_role` both surface the same generic copy on the form so an
 * attacker cannot probe whether an email belongs to a superadmin.
 */

export type SuperadminLoginResult =
  | { ok: true }
  | { ok: false; error: "invalid_credentials" | "no_role" | "server_error" };

export async function loginSuperadmin(
  email: string,
  password: string,
): Promise<SuperadminLoginResult> {
  const trimmedEmail = email.trim().toLowerCase();
  if (!trimmedEmail || !password) {
    return { ok: false, error: "invalid_credentials" };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: trimmedEmail,
    password,
  });

  if (error || !data.user) {
    return { ok: false, error: "invalid_credentials" };
  }

  const role = await getSuperAdminRole(data.user.id);
  if (role === null) {
    // Signed in via Supabase but not (or no longer) a superadmin. Sign
    // out immediately so the salon-facing surfaces don't pick up the
    // session — superadmin login should never leak into the salon
    // dashboard.
    await supabase.auth.signOut();
    return { ok: false, error: "no_role" };
  }

  return { ok: true };
}

/**
 * Signs the current user out. Used by the impersonation exit flow and
 * by the superadmin "Sign out" affordance once it lands. Kept in this
 * module so the action file owns every auth verb the surface uses.
 */
export async function logoutSuperadmin(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
}
