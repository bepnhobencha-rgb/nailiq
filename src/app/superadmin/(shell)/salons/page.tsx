import { createClient } from "@/shared/lib/supabase/server";
import { loadAllSalons } from "@/shared/superadmin/superadminActions";
import { SuperAdminPanel } from "@/components/superadmin/SuperAdminPanel";

export const dynamic = "force-dynamic";

/**
 * Temporary home for the existing `SuperAdminPanel` from PR #82
 * (per-salon plan + feature-flag overrides).
 *
 * Phase 1D will replace this with a proper salons list + detail
 * page split; the override controls move to the per-salon detail
 * page. The URL stays the same so existing bookmarks survive.
 *
 * Auth + role gate runs in the parent `(shell)/layout.tsx` so this
 * page can assume an active superadmin.
 */
export default async function SuperadminSalonsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const result = await loadAllSalons();
  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Salons
        </h1>
        <p className="mt-6 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          Failed to load salons ({result.error}). Check
          SUPABASE_SERVICE_ROLE_KEY and the migration state.
        </p>
      </main>
    );
  }

  return (
    <SuperAdminPanel
      salons={result.salons}
      viewerEmail={user?.email ?? null}
    />
  );
}
