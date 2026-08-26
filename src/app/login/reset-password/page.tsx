import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { requireActivePasswordRecoverySession } from "@/shared/auth/requireActivePasswordRecoverySession";
import { SalonOwnerResetPasswordForm } from "./SalonOwnerResetPasswordForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Set new password · NailIQ" },
  robots: { index: false, follow: false },
};

/**
 * Landing page for salon owner password-recovery flow.
 *
 * The recovery email link first hits `/auth/recovery` (a route handler
 * that exchanges `?code=…` for a session and persists cookies) and
 * then redirects here. By the time this page renders we either have a
 * recovery session (the happy path) or no user at all (link expired,
 * already consumed, or someone hand-typed the URL).
 *
 * Renders three states:
 *   - happy path: form to set a new password
 *   - no session: link likely expired — redirect to /login/forgot-password
 *   - signed in but no longer a salon member: redirect to /login
 *     so they can't pivot the recovery session into a different surface
 */
export default async function SalonOwnerResetPasswordPage() {
  const supabase = await createClient();
  const recovery = await requireActivePasswordRecoverySession(supabase);
  if (!recovery.ok) {
    redirect(
      recovery.code === "auth_unavailable"
        ? "/login/forgot-password?notice=temporarily_unavailable"
        : "/login/forgot-password?notice=invalid_or_expired",
    );
  }

  const { data: membership, error: membershipError } = await supabase
    .from("salon_members")
    .select("id")
    .eq("user_id", recovery.user.id)
    .limit(1)
    .maybeSingle();
  if (membershipError || !membership) {
    await supabase.auth.signOut({ scope: "global" });
    redirect("/login");
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
          Choose a strong password (8+ characters with uppercase and numbers recommended). You&apos;ll be
          signed out and asked to sign in fresh with the new password.
        </p>
      </header>

      <SalonOwnerResetPasswordForm />
    </main>
  );
}
