import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { SalonOwnerDashboardSkeleton } from "@/components/dashboard/SalonOwnerDashboardSkeleton";

export default function SalonDashboardLoading() {
  return (
    <ResponsiveShell>
      <div
        className="mx-auto min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-6 sm:pt-8"
        aria-busy
        aria-label="Loading dashboard"
      >
        <div className="mb-6 space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-nq-muted/25" />
          <div className="h-8 w-3/4 max-w-xs animate-pulse rounded bg-nq-muted/30" />
          <div className="h-4 w-full max-w-sm animate-pulse rounded bg-nq-muted/20" />
        </div>
        <SalonOwnerDashboardSkeleton />
      </div>
    </ResponsiveShell>
  );
}
