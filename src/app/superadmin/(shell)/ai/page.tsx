import Link from "next/link";

const tools = [
  {
    href: "/superadmin/ai/costs",
    title: "AI Cost Ledger",
    description:
      "Track model usage, estimated cost, outcomes, and cost per conversion across salons.",
  },
  {
    href: "/superadmin/ai/performance",
    title: "Agent Certification Matrix",
    description:
      "See which agents have recent runtime evidence, are waiting for data, need configuration, or failed.",
  },
] as const;

export default function AiIndexPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-nq-muted">
          SuperAdmin · Platform-wide
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-nq-foreground">
          AI Operations
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-nq-muted">
          Monitor AI reliability and spend across NailIQ. Salon owners manage
          their own agents from the salon AI Control Center.
        </p>
      </header>

      <ul className="grid gap-3 sm:grid-cols-2">
        {tools.map((tool) => (
          <li key={tool.href}>
            <Link
              href={tool.href}
              className="block h-full rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5 transition-colors hover:border-nq-primary/45 hover:bg-nq-surface/60"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold text-nq-foreground">{tool.title}</h2>
                <span className="rounded-full border border-nq-success/45 bg-nq-success/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-nq-success">
                  Live
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-nq-muted">
                {tool.description}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
