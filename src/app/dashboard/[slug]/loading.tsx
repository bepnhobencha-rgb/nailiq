import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SalonOwnerDashboardSkeleton } from "@/components/dashboard/SalonOwnerDashboardSkeleton";

export default function SalonDashboardLoading() {
  return (
    <ResponsiveShell className="bg-nq-bg text-nq-foreground">
      <div
        role="status"
        className="mx-auto min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 sm:pt-8"
        aria-label="Loading dashboard"
      >
        <div className="mb-6 flex items-center gap-3" aria-hidden="true">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-nq-primary/35 bg-nq-primary/10 text-sm font-bold text-nq-primary">
            NQ
          </span>
          <div>
            <p className="text-sm font-semibold text-nq-foreground">
              Loading dashboard…
            </p>
            <p className="mt-0.5 text-xs text-nq-muted">
              Your salon data is unchanged.
            </p>
          </div>
          <span className="ml-auto h-5 w-5 animate-spin rounded-full border-2 border-nq-primary/25 border-t-nq-primary" />
        </div>
        <div className="mb-6 space-y-2" aria-hidden="true">
          <div className="h-3 w-24 animate-pulse rounded bg-nq-muted/25" />
          <div className="h-8 w-3/4 max-w-xs animate-pulse rounded bg-nq-muted/30" />
          <div className="h-4 w-full max-w-sm animate-pulse rounded bg-nq-muted/20" />
        </div>
        <SalonOwnerDashboardSkeleton />
      </div>
    </ResponsiveShell>
  );
}
