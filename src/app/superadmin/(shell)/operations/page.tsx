import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * Operations is a directory of production-ready operator tools.
 * Unimplemented roadmap routes stay out of the navigation so the
 * console never presents placeholders as working controls.
 */
const items = [
  {
    href: "/superadmin/operations/feature-flags",
    title: "Platform feature flags",
    blurb:
      "Toggle global switches (demo OTP, Stripe billing, SMS, email, new-salon registration).",
    phase: "Live",
  },
  {
    href: "/superadmin/operations/announcements",
    title: "Announcements",
    blurb:
      "Broadcast notices to owners / staff / superadmins. Drafts + scheduled publish.",
    phase: "Live",
  },
  {
    href: "/superadmin/operations/system-health",
    title: "System health",
    blurb:
      "Self-hosted error monitor: grouped app errors with AI summary, suggested fix, and AI-drafted PRs.",
    phase: "Live",
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
          </li>
        ))}
      </ul>
    </main>
  );
}
