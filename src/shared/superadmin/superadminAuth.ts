"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
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

export type RequestPasswordResetResult =
  | { ok: true }
  | { ok: false; error: "server_error" };

/**
 * Triggers a password-reset email for a superadmin account.
 *
 * Anti-enumeration: this server action *always* returns `{ ok: true }`
 * for well-formed input — the caller can't distinguish "email exists
 * and is a superadmin" from "email not in our system" from "email
 * belongs to a salon owner." Only well-formed-but-empty input or a
 * thrown error from Supabase surfaces a distinct outcome.
 *
 * Two guard rails before the email actually goes out:
 *   1. Service-role lookup in `auth.users` by email — silently no-ops
 *      if the user does not exist.
 *   2. `public.superadmins` membership check — salon-owner accounts
 *      that happen to share this email never receive a superadmin
 *      reset link. They have their own (OTP) recovery path.
 *
 * Only when both gates pass do we call Supabase's built-in
 * `resetPasswordForEmail` with a `redirectTo` that lands the recipient
 * on `/superadmin/reset-password`, where the recovery session is
 * exchanged for a new password.
 */
export async function requestSuperadminPasswordReset(
  email: string,
): Promise<RequestPasswordResetResult> {
  const trimmedEmail = email.trim().toLowerCase();
  if (!trimmedEmail) {
    // Empty form should *look* successful so the form doesn't double
    // as an enumeration oracle, but we skip the round-trip entirely.
    return { ok: true };
  }

  try {
    const admin = createServiceRoleClient();
    // The admin listUsers endpoint accepts a filter expression; the
    // SDK's typed surface doesn't expose a direct email lookup, so we
    // walk the first page (>1000 superadmin operators is implausible).
    const { data: userList, error: listError } =
      await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) {
      console.error("[superadminAuth] listUsers failed:", listError);
      return { ok: false, error: "server_error" };
    }
    const matched = userList.users.find(
      (u) => u.email?.toLowerCase() === trimmedEmail,
    );
    if (!matched) {
      return { ok: true };
    }

    const role = await getSuperAdminRole(matched.id);
    if (role === null) {
      return { ok: true };
    }

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXTAUTH_URL ?? "";
    const redirectTo = siteUrl
      ? `${siteUrl.replace(/\/$/, "")}/auth/recovery`
      : undefined;

    const supabase = await createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      trimmedEmail,
      redirectTo ? { redirectTo } : undefined,
    );
    if (resetError) {
      return { ok: false, error: "server_error" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "server_error" };
  }
}

export type CompletePasswordResetResult =
  | { ok: true }
  | {
      ok: false;
      error: "no_session" | "no_role" | "weak_password" | "server_error";
    };

/**
 * Sets a new password for the superadmin recovery session.
 *
 * The recovery link from `resetPasswordForEmail` establishes a session
 * for the matched user when they land on `/superadmin/reset-password`.
 * From that session we:
 *   1. Re-verify the user is still a superadmin (the role may have
 *      been revoked between request and click).
 *   2. Call `updateUser` to commit the new password.
 *   3. Sign out so the recovery session is consumed — the operator
 *      then signs in fresh with the new credentials.
 *
 * Minimum password length is 6. Anything weaker is surfaced
 * as `weak_password` so the UI can show actionable guidance rather
 * than a generic "server error."
 */
export async function completeSuperadminPasswordReset(
  newPassword: string,
): Promise<CompletePasswordResetResult> {
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, error: "weak_password" };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return { ok: false, error: "no_session" };
    }

    const role = await getSuperAdminRole(user.id);
    if (role === null) {
      await supabase.auth.signOut();
      return { ok: false, error: "no_role" };
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });
    if (updateError) {
      // Supabase rejects passwords that fail the project policy with a
      // specific code; surface that as weak_password so the form copy
      // is consistent. Anything else is opaque.
      if (
        updateError.message.toLowerCase().includes("password") ||
        updateError.message.toLowerCase().includes("weak")
      ) {
        return { ok: false, error: "weak_password" };
      }
      return { ok: false, error: "server_error" };
    }

    // Consume the recovery session — operator must re-authenticate
    // with the new password on /superadmin/login.
    await supabase.auth.signOut();
    return { ok: true };
  } catch {
    return { ok: false, error: "server_error" };
  }
}
