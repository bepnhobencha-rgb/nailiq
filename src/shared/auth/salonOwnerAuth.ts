"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

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
 * Guard rails before the email goes out:
 *   1. Service-role lookup in `auth.users` by email — silently no-ops
 *      if the user does not exist.
 *   2. `public.salon_members` membership check — only users with a
 *      salon owner/staff membership receive a reset link. Users who
 *      signed up but were never added to a salon don't receive one.
 *
 * Only when both gates pass do we call Supabase's built-in
 * `resetPasswordForEmail` with a `redirectTo` that lands the recipient
 * on `/auth/recovery` (shared with superadmin), which exchanges the code
 * for a session and redirects to `/login/reset-password`.
 */

export type RequestPasswordResetResult =
  | { ok: true }
  | { ok: false; error: "server_error" };

export async function requestSalonOwnerPasswordReset(
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
    // walk the first page (>1000 salon owners is implausible).
    const { data: userList, error: listError } =
      await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) {
      console.error("[salonOwnerAuth] listUsers failed:", listError);
      return { ok: false, error: "server_error" };
    }
    const matched = userList.users.find(
      (u) => u.email?.toLowerCase() === trimmedEmail,
    );
    if (!matched) {
      return { ok: true };
    }

    // Check if this user has a salon owner/staff membership.
    //
    // MUST use the service-role client: the caller is an UNAUTHENTICATED
    // visitor on the forgot-password form, and `salon_members` has RLS
    // that only lets an authenticated user read their own row
    // (`auth.uid() = user_id`). Querying it through the request-scoped
    // anon client returns zero rows for everyone, so the reset email
    // would never be sent. `.maybeSingle()` (not `.single()`) so a
    // multi-salon owner with >1 membership rows isn't treated as a
    // non-member.
    const { data: membership, error: membershipError } = await admin
      .from("salon_members")
      .select("id")
      .eq("user_id", matched.id)
      .limit(1)
      .maybeSingle();

    if (membershipError || !membership) {
      // User exists in auth but is not a salon member — silently no-op
      return { ok: true };
    }

    const supabase = await createClient();

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXTAUTH_URL ?? "";
    const redirectTo = siteUrl
      ? `${siteUrl.replace(/\/$/, "")}/auth/recovery`
      : undefined;

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

    // Check if user is still a salon member
    const { data: membership } = await supabase
      .from("salon_members")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (!membership) {
      await supabase.auth.signOut();
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

    // Consume the recovery session — owner must re-authenticate
    // with the new password on /login.
    await supabase.auth.signOut();
    return { ok: true };
  } catch {
    return { ok: false, error: "server_error" };
  }
}
