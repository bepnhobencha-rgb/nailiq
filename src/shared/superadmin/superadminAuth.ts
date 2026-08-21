"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/shared/lib/supabase/server";
import { clearSuperAdminCache, getSuperAdminRole } from "@/shared/lib/superadmin";
import { consumePublicServerActionRateLimit } from "@/shared/security/publicServerActionRateLimit";
import { requireActiveAuthSession } from "@/shared/auth/requireActiveAuthSession";
import {
  canonicalPasswordResetEmail,
  isAcceptableRecoveryPassword,
  issuePasswordRecoveryIntent,
  PASSWORD_RECOVERY_COOKIE,
  passwordRecoveryRedirectUrl,
  sessionIdFromAccessToken,
  verifyPasswordRecoveryCapability,
} from "@/shared/auth/passwordRecoverySecurity";

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

  const rate = await consumePublicServerActionRateLimit({
    scope: "superadmin-password-login",
    identity: trimmedEmail,
    ipLimits: [[8, 300], [30, 3_600]],
    identityLimits: [[5, 300], [15, 3_600]],
  });
  if (rate === "limited") return { ok: false, error: "invalid_credentials" };
  if (rate === "unavailable") return { ok: false, error: "server_error" };

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

/**
 * Server action wired to the "Sign out" button in SuperadminSignOutButton.
 * Delegates the actual sign-out to `logoutSuperadmin`, then hard-redirects to
 * the login page so no stale session state lingers in the client.
 */
export async function signOutSuperadminAction(): Promise<void> {
  await logoutSuperadmin();
  redirect("/superadmin/login");
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
 * We deliberately avoid a service-role email lookup here. The provider request
 * has a uniform public response, while the callback checks the authenticated
 * user's current role before issuing the short-lived reset capability.
 */
export async function requestSuperadminPasswordReset(
  email: string,
): Promise<RequestPasswordResetResult> {
  const trimmedEmail = canonicalPasswordResetEmail(email);
  if (!trimmedEmail) {
    // Empty form should *look* successful so the form doesn't double
    // as an enumeration oracle, but we skip the round-trip entirely.
    return { ok: true };
  }

  const rate = await consumePublicServerActionRateLimit({
    scope: "superadmin-password-reset",
    identity: trimmedEmail,
    ipLimits: [[10, 3_600]],
    identityLimits: [[3, 3_600]],
  });
  if (rate === "limited") return { ok: true };
  if (rate === "unavailable") return { ok: false, error: "server_error" };

  try {
    const redirectTo = passwordRecoveryRedirectUrl(
      "superadmin",
      issuePasswordRecoveryIntent({
        email: trimmedEmail,
        surface: "superadmin",
      }),
    );
    const supabase = await createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      trimmedEmail,
      { redirectTo },
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
 * Password bounds are shared with the salon-owner flow. Anything weaker is surfaced
 * as `weak_password` so the UI can show actionable guidance rather
 * than a generic "server error."
 */
export async function completeSuperadminPasswordReset(
  newPassword: string,
): Promise<CompletePasswordResetResult> {
  if (!isAcceptableRecoveryPassword(newPassword)) {
    return { ok: false, error: "weak_password" };
  }

  try {
    const supabase = await createClient();
    const session = await requireActiveAuthSession(supabase);
    if (!session.ok) {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // The password update remains blocked even if cookie cleanup fails.
      }
      return {
        ok: false,
        error:
          session.code === "auth_unavailable" ? "server_error" : "no_session",
      };
    }
    const user = session.user;

    const { data: sessionData, error: sessionError } =
      await supabase.auth.getSession();
    const sessionId = sessionIdFromAccessToken(
      sessionData.session?.access_token,
    );
    const cookieStore = await cookies();
    if (
      sessionError ||
      !sessionId ||
      !verifyPasswordRecoveryCapability({
        token: cookieStore.get(PASSWORD_RECOVERY_COOKIE)?.value,
        userId: user.id,
        sessionId,
      })
    ) {
      return { ok: false, error: "no_session" };
    }

    clearSuperAdminCache(user.id);
    const role = await getSuperAdminRole(user.id);
    if (role === null) {
      await supabase.auth.signOut({ scope: "global" });
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

    try {
      cookieStore.delete(PASSWORD_RECOVERY_COOKIE);
    } catch {
      // Global session revocation below still invalidates the bound session id.
    }
    try {
      const { error: globalSignOutError } = await supabase.auth.signOut({
        scope: "global",
      });
      if (globalSignOutError) {
        await supabase.auth.signOut({ scope: "local" });
      }
    } catch {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // Password truth is already committed and the recovery bearer is gone.
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "server_error" };
  }
}
