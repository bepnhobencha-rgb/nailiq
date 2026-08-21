import { type ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import {
  clearInactiveServerSession,
  requireActiveSuperAdminSession,
} from "@/shared/auth/requireActiveSuperAdminSession";
import { SuperadminSidebar } from "@/components/superadmin/SuperadminSidebar";
import { SuperadminBottomNav } from "@/components/superadmin/SuperadminBottomNav";
import { SuperadminTopBar } from "@/components/superadmin/SuperadminTopBar";
import { ReleaseReviewNotice } from "@/components/superadmin/ReleaseReviewNotice";
import { currentReleaseReviewContext } from "@/shared/superadmin/releaseReviewContext";
import { resolveReleaseReviewNotice } from "@/shared/superadmin/releaseReviewStore";

export const dynamic = "force-dynamic";

/**
 * Shell layout for `/superadmin/*` (excluding `/superadmin/login`).
 *
 * Per `docs/DASHBOARD_LAYOUT_RULES.md` §10:
 *   - Sidebar at `md+` with 240px expanded / 64px collapsed.
 *   - Bottom-tab bar below `md`.
 *   - Main content shifts right by sidebar width on `md+`.
 *
 * Role gate runs HERE (not per-page) so every shell route inherits the
 * same membership check. Pages still receive `role` via React Context
 * if they need to branch on it — for Phase 1C they don't, but the
 * layout fetches it once to keep the per-page boilerplate thin.
 */
export default async function SuperadminShellLayout({
  children,
}: {
  children: ReactNode;
}) {
  const access = await requireActiveSuperAdminSession();
  if (!access.ok) {
    if (access.code === "forbidden") notFound();
    // Proxy normally handles this, but the redirect here is a
    // defense-in-depth so a stale/revoked cookie can't leak the shell.
    await clearInactiveServerSession(access.supabase);
    redirect("/superadmin/login?notice=reauthentication_required");
  }
  const { role, supabase } = access;

  // Soft two-factor gate: ONLY superadmins who have enrolled a verified TOTP
  // factor are challenged (nextLevel resolves to 'aal2'). An un-enrolled account
  // resolves to 'aal1' and is never prompted — so this can't lock anyone out.
  // The challenge page lives at /superadmin/mfa (outside this shell group) so
  // it isn't itself gated (no redirect loop). FAIL-OPEN: any error resolving the
  // assurance level lets the request through rather than locking the panel.
  let needsMfa = false;
  try {
    const { data: aal } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    needsMfa = aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2";
  } catch {
    needsMfa = false;
  }
  if (needsMfa) redirect("/superadmin/mfa");

  const releaseReview = ["founder", "ops_admin"].includes(role)
    ? await resolveReleaseReviewNotice(currentReleaseReviewContext())
    : null;

  return (
    <div className="min-h-dvh bg-nq-bg text-nq-foreground">
      <SuperadminSidebar role={role} />
      <SuperadminBottomNav role={role} />
      {/* Mobile-only top bar with wordmark + sign-out; hidden at md+ where sidebar handles it */}
      <SuperadminTopBar />
      <div className="md:pl-60 pb-14 md:pb-0">
        <ReleaseReviewNotice review={releaseReview} />
        {children}
      </div>
    </div>
  );
}
