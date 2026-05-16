import { SalonListTable } from "@/components/superadmin/SalonListTable";
import { loadAllSalons } from "@/shared/superadmin/superadminActions";

export const dynamic = "force-dynamic";

/**
 * `/superadmin/salons` — salon list (read-only).
 *
 * Per-salon override controls live on the detail page
 * (`/superadmin/salons/[salonId]`). Platform-wide flags moved to
 * `/superadmin/operations/feature-flags` in Phase 1F (this
 * supplanted the temporary "Legacy panel" link that briefly
 * existed at `/superadmin/salons-legacy`).
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
