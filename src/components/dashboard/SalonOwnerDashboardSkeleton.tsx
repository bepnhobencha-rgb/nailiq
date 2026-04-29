/** Pulse placeholders matching dashboard stats + list density */
export function SalonOwnerDashboardSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden>
      <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[1, 2, 3, 4].map((k) => (
          <div
            key={k}
            className="rounded-xl border border-nq-border/25 bg-nq-surface/30 px-3 py-3"
          >
            <div className="h-3 w-16 rounded bg-nq-muted/25" />
            <div className="mt-2 h-7 w-10 rounded bg-nq-muted/30" />
          </div>
        ))}
      </div>
      <div className="mt-8 space-y-2">
        <div className="h-6 w-40 rounded bg-nq-muted/25" />
        {[1, 2].map((k) => (
          <div
            key={k}
            className="h-24 rounded-2xl border border-nq-border/20 bg-nq-surface/25"
          />
        ))}
      </div>
      <div className="mt-8 space-y-2">
        <div className="h-6 w-48 rounded bg-nq-muted/25" />
        <div className="h-20 rounded-2xl border border-nq-border/20 bg-nq-surface/25" />
      </div>
    </div>
  );
}
