import { PlatformFlagsAdmin } from "@/components/superadmin/PlatformFlagsAdmin";
import { loadPlatformFlags } from "@/shared/superadmin/superadminActions";

export const dynamic = "force-dynamic";

/**
 * Phase 1F — real platform flags admin (replaces the 1C placeholder).
 *
 * Auth + role gate run in `(shell)/layout.tsx`. Per
 * `PERMISSION_MATRIX §8.6` Operations routes are reachable by
 * `founder` and `ops_admin`; the sidebar entry surfaces this and the
 * server action's own gate (`isSuperAdmin`) is the authoritative
 * backstop.
 */
export default async function FeatureFlagsPage() {
  const result = await loadPlatformFlags();

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <header className="mb-6">
        <p className="text-xs font-semibold tracking-[0.18em] text-nq-muted uppercase">
          SuperAdmin · Operations
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-nq-foreground">
          Platform feature flags
        </h1>
      </header>

      <PlatformFlagsAdmin
        initialFlags={result.ok ? result.flags : []}
        loadError={result.ok ? null : result.error}
      />
    </main>
  );
}
