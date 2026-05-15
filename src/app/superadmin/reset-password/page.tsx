import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { SuperadminResetPasswordForm } from "./SuperadminResetPasswordForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Set new password · NailIQ SuperAdmin" },
  robots: { index: false, follow: false },
};

/**
 * Landing page for Supabase's password-recovery flow.
 *
 * Supabase exchanges the recovery token in the email link for a
 * session before this page renders, so by the time `getUser()` resolves
 * we either have a recovery session (the happy path) or no user at all
 * (link expired, already consumed, or someone hand-typed the URL).
 *
 * Renders three states:
 *   - happy path: form to set a new password
 *   - no session: link likely expired — redirect to /superadmin/forgot-password
 *   - signed in but no longer a superadmin: redirect to /superadmin/login
 *     so they can't pivot the recovery session into a different surface
 */
export default async function SuperadminResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/superadmin/forgot-password");
  }

  const role = await getSuperAdminRole(user.id);
  if (role === null) {
    await supabase.auth.signOut();
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
          Choose a password at least 12 characters long. You&apos;ll be
          signed out and asked to sign in fresh with the new password.
        </p>
      </header>

      <SuperadminResetPasswordForm />
    </main>
  );
}
