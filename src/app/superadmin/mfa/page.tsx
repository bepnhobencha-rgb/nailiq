import { notFound, redirect } from "next/navigation";
import {
  clearInactiveServerSession,
  requireActiveSuperAdminSession,
} from "@/shared/auth/requireActiveSuperAdminSession";
import { MfaChallengeForm } from "@/components/superadmin/MfaChallengeForm";

export const dynamic = "force-dynamic";

/**
 * Login-time TOTP challenge for superadmins who have 2FA enabled. Lives OUTSIDE
 * the (shell) group so the shell's soft 2FA gate can redirect here without a
 * loop. Reachable at aal1 (just logged in); once verified the session is aal2
 * and the shell lets them through.
 */
export default async function SuperadminMfaPage() {
  const access = await requireActiveSuperAdminSession();
  if (!access.ok) {
    if (access.code === "forbidden") notFound();
    await clearInactiveServerSession(access.supabase);
    redirect("/superadmin/login?notice=reauthentication_required");
  }
  const { supabase } = access;

  const { data: aal } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  // Already stepped up, or no factor to challenge → nothing to do here.
  if (aal?.currentLevel === "aal2" || aal?.nextLevel !== "aal2") {
    redirect("/superadmin");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-nq-bg px-4">
      <div className="w-full max-w-sm rounded-2xl border border-nq-border/50 bg-nq-surface/60 p-6 shadow-nq-card">
        <h1 className="text-xl font-semibold text-nq-foreground">
          Two-factor verification
        </h1>
        <p className="mt-1 text-sm text-nq-muted">
          Enter the 6-digit code from your authenticator app to continue.
        </p>
        <div className="mt-5">
          <MfaChallengeForm />
        </div>
      </div>
    </main>
  );
}
