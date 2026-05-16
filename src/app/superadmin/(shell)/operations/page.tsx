import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * Phase 1F — Operations index becomes a directory after the two
 * Foundation V1 sub-routes (`feature-flags`, `announcements`) ship.
 * Phase 2 sub-routes still render their own ComingSoonPage; this
 * index is the landing page that lists what's reachable today and
 * what's coming.
 */
const items = [
  {
    href: "/superadmin/operations/feature-flags",
    title: "Platform feature flags",
    blurb:
      "Toggle global switches (demo OTP, Stripe billing, SMS, email, new-salon registration).",
    phase: "Live",
    live: true,
  },
  {
    href: "/superadmin/operations/announcements",
    title: "Announcements",
    blurb:
      "Broadcast notices to owners / staff / superadmins. Drafts + scheduled publish.",
    phase: "Live",
    live: true,
  },
  {
    href: "/superadmin/operations/incidents",
    title: "Incident center",
    blurb: "Triage active incidents, assign ownership, status updates.",
    phase: "Phase 2",
    live: false,
  },
  {
    href: "/superadmin/operations/system-health",
    title: "System health",
    blurb:
      "Live signals: error rate, p95 latency, Supabase quotas, Sentry budget.",
    phase: "Phase 2",
    live: false,
  },
  {
    href: "/superadmin/operations/maintenance",
    title: "Maintenance mode",
    blurb: "Platform-wide read-only window. Schedule + enforce.",
    phase: "Phase 2",
    live: false,
  },
  {
    href: "/superadmin/operations/rollouts",
    title: "Rollout engine",
    blurb: "Staged feature rollouts: cohorts, ramps, kill-switch.",
    phase: "Phase 3",
    live: false,
  },
];

export default function OperationsIndexPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <header className="mb-6">
        <p className="text-xs font-semibold tracking-[0.18em] text-nq-muted uppercase">
          SuperAdmin
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-nq-foreground">
          Operations
        </h1>
      </header>

      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.href}>
            {item.live ? (
              <Link
                href={item.href}
                className="block h-full rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-4 transition-colors hover:border-nq-primary/45 hover:bg-nq-surface/60"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-nq-foreground">
                    {item.title}
                  </h2>
                  <span className="rounded-full border border-nq-success/45 bg-nq-success/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-nq-success">
                    {item.phase}
                  </span>
                </div>
                <p className="mt-1 text-xs text-nq-muted">{item.blurb}</p>
              </Link>
            ) : (
              <span
                aria-disabled
                className="block h-full cursor-not-allowed rounded-2xl border border-nq-border/40 bg-nq-surface/20 p-4 opacity-60"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-nq-muted">
                    {item.title}
                  </h2>
                  <span className="rounded-full border border-nq-border/45 bg-nq-bg/45 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-nq-muted">
                    {item.phase}
                  </span>
                </div>
                <p className="mt-1 text-xs text-nq-muted/80">{item.blurb}</p>
              </span>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
