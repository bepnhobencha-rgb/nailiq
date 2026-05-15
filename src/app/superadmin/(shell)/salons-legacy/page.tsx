import { createClient } from "@/shared/lib/supabase/server";
import {
  loadAllSalons,
  loadPlatformFlags,
} from "@/shared/superadmin/superadminActions";
import { SuperAdminPanel } from "@/components/superadmin/SuperAdminPanel";

export const dynamic = "force-dynamic";

/**
 * `/superadmin/salons-legacy` — temporary host for the original
 * `SuperAdminPanel` (PR #82). Kept reachable so the Global Flags
 * admin tab stays usable until Phase 1F lands a dedicated
 * `/superadmin/operations/feature-flags` page.
 *
 * The new list (`/superadmin/salons`) links here in small text;
 * once 1F ships, this file + `SuperAdminPanel.tsx` can be deleted.
 *
 * Auth + role gate runs in `(shell)/layout.tsx`.
 */
export default async function SuperadminSalonsLegacyPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [salonsResult, platformFlagsResult] = await Promise.all([
    loadAllSalons(),
    loadPlatformFlags(),
  ]);

  if (!salonsResult.ok) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Salons (legacy)
        </h1>
        <p className="mt-6 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          Failed to load salons ({salonsResult.error}). Check
          SUPABASE_SERVICE_ROLE_KEY and the migration state.
        </p>
      </main>
    );
  }

  return (
    <SuperAdminPanel
      salons={salonsResult.salons}
      viewerEmail={user?.email ?? null}
      initialPlatformFlags={
        platformFlagsResult.ok ? platformFlagsResult.flags : []
      }
      platformFlagsError={
        platformFlagsResult.ok ? null : platformFlagsResult.error
      }
    />
  );
}
