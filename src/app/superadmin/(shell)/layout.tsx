import { type ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/shared/lib/supabase/server";
import { getSuperAdminRole } from "@/shared/lib/superadmin";
import { SuperadminSidebar } from "@/components/superadmin/SuperadminSidebar";
import { SuperadminBottomNav } from "@/components/superadmin/SuperadminBottomNav";
import { SuperadminTopBar } from "@/components/superadmin/SuperadminTopBar";

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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Proxy normally handles this, but the redirect here is a
    // defense-in-depth so a misconfigured proxy can't leak the shell.
    redirect("/superadmin/login");
  }

  const role = await getSuperAdminRole(user.id);
  if (role === null) {
    // Authenticated but not (or no longer) a superadmin — per §8.3 we
    // do not reveal that the shell exists. notFound() bubbles to the
    // global 404 (it returns `never`, so TS narrows below).
    notFound();
  }

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

  return (
    <div className="min-h-dvh bg-nq-bg text-nq-foreground">
      <SuperadminSidebar role={role} />
      <SuperadminBottomNav role={role} />
      {/* Mobile-only top bar with wordmark + sign-out; hidden at md+ where sidebar handles it */}
      <SuperadminTopBar />
      <div className="md:pl-60 pb-14 md:pb-0">{children}</div>
    </div>
  );
}
