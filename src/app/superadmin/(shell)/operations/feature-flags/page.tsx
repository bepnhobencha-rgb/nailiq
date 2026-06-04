import { PlatformFlagsAdmin } from "@/components/superadmin/PlatformFlagsAdmin";
import { PlatformFeatureVisibilityAdmin } from "@/components/superadmin/PlatformFeatureVisibilityAdmin";
import { loadPlatformFlags } from "@/shared/superadmin/superadminActions";
import { loadPlatformFeatureStates } from "@/shared/features/platformFeatureFlags";

export const dynamic = "force-dynamic";

/**
 * SuperAdmin · Operations — two distinct control planes on one page:
 *
 *  1. Platform INFRASTRUCTURE flags (`platform_flags`: OTP/SMS/email/billing/
 *     registration) — transport + signup switches. Do NOT control which
 *     product features a salon dashboard shows.
 *  2. Platform FEATURE VISIBILITY (kill-switches) — hide a product feature for
 *     every salon, overriding per-salon settings. Per-salon control lives on
 *     each salon's detail page.
 *
 * Auth + role gate run in `(shell)/layout.tsx`; each server action re-checks
 * `isSuperAdmin` as the authoritative backstop.
 */
export default async function FeatureFlagsPage() {
  const [result, featureStates] = await Promise.all([
    loadPlatformFlags(),
    loadPlatformFeatureStates(),
  ]);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <header className="mb-6">
        <p className="text-xs font-semibold tracking-[0.18em] text-nq-muted uppercase">
          SuperAdmin · Operations
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-nq-foreground">
          Platform flags
        </h1>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-nq-foreground">
          Infrastructure
        </h2>
        <PlatformFlagsAdmin
          initialFlags={result.ok ? result.flags : []}
          loadError={result.ok ? null : result.error}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-nq-foreground">
          Feature visibility
        </h2>
        <PlatformFeatureVisibilityAdmin initialStates={featureStates} />
      </section>
    </main>
  );
}
