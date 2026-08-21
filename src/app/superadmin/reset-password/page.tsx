import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { requireActivePasswordRecoverySession } from "@/shared/auth/requireActivePasswordRecoverySession";
import { clearSuperAdminCache, getSuperAdminRole } from "@/shared/lib/superadmin";
import { SuperadminResetPasswordForm } from "./SuperadminResetPasswordForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Set new password · NailIQ SuperAdmin" },
  robots: { index: false, follow: false },
};

/**
 * Landing page for Supabase's password-recovery flow.
 *
 * The recovery email link first hits `/auth/recovery` (a route handler
 * that exchanges `?code=…` for a session and persists cookies) and
 * then redirects here. By the time this page renders we either have a
 * recovery session (the happy path) or no user at all (link expired,
 * already consumed, or someone hand-typed the URL).
 *
 * Renders three states:
 *   - happy path: form to set a new password
 *   - no session: link likely expired — redirect to /superadmin/forgot-password
 *   - signed in but no longer a superadmin: redirect to /superadmin/login
 *     so they can't pivot the recovery session into a different surface
 */
export default async function SuperadminResetPasswordPage() {
  const supabase = await createClient();
  const recovery = await requireActivePasswordRecoverySession(supabase);
  if (!recovery.ok) {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // Redirect remains fail closed even if local cookie cleanup fails.
    }
    redirect(
      recovery.code === "auth_unavailable"
        ? "/superadmin/forgot-password?notice=temporarily_unavailable"
        : "/superadmin/forgot-password?notice=invalid_or_expired",
    );
  }

  clearSuperAdminCache(recovery.user.id);
  const role = await getSuperAdminRole(recovery.user.id);
  if (!role) {
    await supabase.auth.signOut({ scope: "global" });
    redirect("/superadmin/login");
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-5 py-16 md:px-8">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
          NailIQ
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Set a new password
        </h1>
        <p className="text-sm text-nq-muted">
          Choose a password at least 8 characters long. You&apos;ll be
          signed out and asked to sign in fresh with the new password.
        </p>
      </header>

      <SuperadminResetPasswordForm />
    </main>
  );
}
