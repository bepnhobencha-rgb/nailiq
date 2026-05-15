import { SalonListTable } from "@/components/superadmin/SalonListTable";
import { loadAllSalons } from "@/shared/superadmin/superadminActions";

export const dynamic = "force-dynamic";

/**
 * `/superadmin/salons` — Phase 1D salon list (read-only).
 *
 * Replaces the temporary `SuperAdminPanel` render from PR #101. The
 * per-salon override controls have moved to the detail page
 * (`/superadmin/salons/[salonId]`). A small "Legacy panel" link
 * inside `SalonListTable` still routes to `SuperAdminPanel` so the
 * Global Flags admin surface stays reachable until Phase 1F lands a
 * dedicated `/superadmin/operations/feature-flags` route.
 *
 * Auth + role gate runs in `(shell)/layout.tsx`, so this page can
 * assume an active superadmin.
 */
export default async function SuperadminSalonsPage() {
  const result = await loadAllSalons();
  if (!result.ok) {
    return (
      <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
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
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <SalonListTable salons={result.salons} />
    </main>
  );
}
