"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { cookies } from "next/headers";
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
 * Salon owner password reset server actions.
 *
 * Salon owners authenticate via email+password (stored in Supabase Auth).
 * When they forget their password, they submit their email and receive
 * a recovery link via email.
 *
 * Anti-enumeration: this server action *always* returns `{ ok: true }`
 * for well-formed input — the caller can't distinguish "email exists
 * and is a salon owner" from "email not in our system" from "email
 * belongs to a superadmin." Only well-formed-but-empty input or a
 * thrown error from Supabase surfaces a distinct outcome.
 *
 * We deliberately do not perform a privileged pre-lookup by email. Supabase's
 * recovery request is itself anti-enumerating, while the callback rechecks the
 * authenticated user's current role before issuing a reset capability.
 */

export type RequestPasswordResetResult =
  | { ok: true }
  | { ok: false; error: "server_error" };

export async function requestSalonOwnerPasswordReset(
  email: string,
): Promise<RequestPasswordResetResult> {
  const trimmedEmail = canonicalPasswordResetEmail(email);
  if (!trimmedEmail) {
    // Malformed and unknown identities share the same public outcome.
    return { ok: true };
  }

  const rate = await consumePublicServerActionRateLimit({
    scope: "salon-password-reset",
    identity: trimmedEmail,
    ipLimits: [[10, 3_600]],
    identityLimits: [[3, 3_600]],
  });
  if (rate === "limited") return { ok: true };
  if (rate === "unavailable") return { ok: false, error: "server_error" };

  try {
    const supabase = await createClient();
    const redirectTo = passwordRecoveryRedirectUrl(
      "salon",
      issuePasswordRecoveryIntent({ email: trimmedEmail, surface: "salon" }),
    );
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
      error:
        | "no_session"
        | "no_salon_member"
        | "weak_password"
        | "server_error";
    };

/**
 * Sets a new password for the salon owner recovery session.
 *
 * The recovery link from `resetPasswordForEmail` establishes a session
 * for the matched user when they land on `/auth/recovery`.
 * From that session we:
 *   1. Re-verify the user is a salon member (the membership may have
 *      been removed between request and click).
 *   2. Call `updateUser` to commit the new password.
 *   3. Sign out so the recovery session is consumed — the owner
 *      then signs in fresh with the new credentials.
 *
 * Minimum password length is 8 (matches the UI). Anything weaker is surfaced
 * as `weak_password` so the UI can show actionable guidance rather
 * than a generic "server error."
 */
export async function completeSalonOwnerPasswordReset(
  newPassword: string,
): Promise<CompletePasswordResetResult> {
  if (!isAcceptableRecoveryPassword(newPassword)) {
    return { ok: false, error: "weak_password" };
  }

  try {
    const supabase = await createClient();
    const active = await requireActiveAuthSession(supabase);
    if (!active.ok) {
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // The password update remains blocked even if cookie cleanup fails.
      }
      return {
        ok: false,
        error:
          active.code === "auth_unavailable" ? "server_error" : "no_session",
      };
    }
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
        userId: active.user.id,
        sessionId,
      })
    ) {
      return { ok: false, error: "no_session" };
    }

    // Check if user is still a salon member
    const { data: membership, error: membershipError } = await supabase
      .from("salon_members")
      .select("id")
      .eq("user_id", active.user.id)
      .limit(1)
      .maybeSingle();

    if (membershipError) {
      return { ok: false, error: "server_error" };
    }
    if (!membership) {
      await supabase.auth.signOut({ scope: "global" });
      return { ok: false, error: "no_salon_member" };
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

    // The password mutation is the terminal effect. Clear the local recovery
    // bearer and revoke the recovery session so a replay cannot mutate again.
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
