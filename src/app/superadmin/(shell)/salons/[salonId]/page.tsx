import { notFound } from "next/navigation";
import { SalonDetailView } from "@/components/superadmin/SalonDetailView";
import { loadSalonDetail } from "@/shared/superadmin/superadminActions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ salonId: string }> };

/**
 * `/superadmin/salons/[salonId]` — Phase 1D salon detail.
 *
 * Read-only configuration + activity summary + the override
 * controls relocated from the legacy SuperAdminPanel. Phase 1E will
 * land a "Login as owner" CTA above the override card.
 *
 * Auth + role gate runs in `(shell)/layout.tsx`.
 */
export default async function SuperadminSalonDetailPage({ params }: Props) {
  const { salonId } = await params;
  const result = await loadSalonDetail(salonId);

  if (!result.ok) {
    if (result.error === "not_found") notFound();
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Salon
        </h1>
        <p className="mt-6 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          Failed to load salon ({result.error}). Check
          SUPABASE_SERVICE_ROLE_KEY and the migration state.
        </p>
      </main>
    );
  }

  return <SalonDetailView salon={result.salon} />;
}
