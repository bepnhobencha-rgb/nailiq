import Link from "next/link";

type Props = {
  /** Section title in the breadcrumb (e.g. "Operations"). */
  section: string;
  /** Subsection or feature name (e.g. "Incident Center"). */
  title: string;
  /** Concrete release marker per DASHBOARD_LAYOUT_RULES.md §10.3 — e.g. "Phase 2", "Q3 2026". Never vague "Coming Soon". */
  phase: string;
  /** One-line description of the eventual capability. No marketing copy. */
  description?: string;
};

/**
 * Architectural placeholder for `/superadmin/*` routes whose business
 * logic has not landed yet. Renders the route surface so the roadmap
 * is legible to operators while making it impossible to interact with
 * absent functionality.
 *
 * Per `docs/DASHBOARD_LAYOUT_RULES.md` §10.3:
 *   - No fake forms, no fake buttons, no fake metrics
 *   - Phase label MUST be concrete (no vague "Coming Soon")
 *   - Only navigable affordance is the back-to-dashboard link
 *
 * Compliant with `ARCHITECTURE_LOCK.md` §5 "Silent failures" rule
 * because there are no interactive controls beyond the back link
 * (a real, working navigation, not a button that does nothing).
 */
export function ComingSoonPage({ section, title, phase, description }: Props) {
  return (
    <main
      data-testid="superadmin-coming-soon"
      data-section={section}
      data-phase={phase}
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12"
    >
      <nav className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
        SuperAdmin · {section}
      </nav>
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          {title}
        </h1>
        <p className="inline-flex w-fit items-center gap-2 rounded-full border border-nq-border bg-nq-surface px-3 py-1 text-xs font-medium text-nq-muted">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-nq-muted"
          />
          Coming {phase}
        </p>
        {description ? (
          <p className="max-w-prose text-sm leading-relaxed text-nq-muted">
            {description}
          </p>
        ) : null}
      </header>
      <p className="text-sm text-nq-muted">
        This module is part of the Superadmin roadmap. The route is reserved so the
        navigation reflects the eventual surface area; business logic lands in the
        phase shown above.
      </p>
      <div className="pt-2">
        <Link
          href="/superadmin/dashboard"
          className="text-sm font-medium text-nq-primary underline-offset-4 hover:underline"
        >
          ← Back to dashboard
        </Link>
      </div>
    </main>
  );
}
