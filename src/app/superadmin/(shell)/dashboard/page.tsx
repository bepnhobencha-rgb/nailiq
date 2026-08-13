import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const dynamic = "force-dynamic";

type Counts = {
  salons: number | null;
  activeSuperadmins: number | null;
  auditEvents7d: number | null;
  activeAnnouncements: number | null;
};

async function loadCounts(): Promise<Counts> {
  let admin;
  try {
    admin = createServiceRoleClient();
  } catch {
    return {
      salons: null,
      activeSuperadmins: null,
      auditEvents7d: null,
      activeAnnouncements: null,
    };
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [salonsRes, superadminsRes, auditRes, announcementsRes] =
    await Promise.all([
      admin.from("salons").select("id", { count: "exact", head: true }),
      (
        admin.from("superadmins") as unknown as {
          select: (
            cols: string,
            options: { count: "exact"; head: true },
          ) => {
            is: (col: string, val: null) => Promise<{
              count: number | null;
              error: { message: string } | null;
            }>;
          };
        }
      )
        .select("user_id", { count: "exact", head: true })
        .is("revoked_at", null),
      (
        admin.from("superadmin_audit_logs") as unknown as {
          select: (
            cols: string,
            options: { count: "exact"; head: true },
          ) => {
            gte: (col: string, val: string) => Promise<{
              count: number | null;
              error: { message: string } | null;
            }>;
          };
        }
      )
        .select("id", { count: "exact", head: true })
        .gte("created_at", sevenDaysAgo),
      (
        admin.from("platform_announcements") as unknown as {
          select: (
            cols: string,
            options: { count: "exact"; head: true },
          ) => {
            not: (col: string, op: string, val: null) => Promise<{
              count: number | null;
              error: { message: string } | null;
            }>;
          };
        }
      )
        .select("id", { count: "exact", head: true })
        .not("published_at", "is", null),
    ]);

  return {
    salons: salonsRes.count,
    activeSuperadmins: superadminsRes.count,
    auditEvents7d: auditRes.count,
    activeAnnouncements: announcementsRes.count,
  };
}

export default async function SuperadminDashboardPage() {
  const counts = await loadCounts();

  return (
    <main
      data-testid="superadmin-dashboard"
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10"
    >
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-nq-muted">
          SuperAdmin · Dashboard
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Control Tower
        </h1>
        <p className="text-sm text-nq-muted">
          Current platform counters and entry points for operator review. Open
          each tool to see its own evidence and readiness state.
        </p>
      </header>

      <section
        aria-label="Platform counters"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <StatCard label="Active salons" value={counts.salons} />
        <StatCard
          label="Active superadmins"
          value={counts.activeSuperadmins}
        />
        <StatCard
          label="Audit events · last 7d"
          value={counts.auditEvents7d}
        />
        <StatCard
          label="Active announcements"
          value={counts.activeAnnouncements}
        />
      </section>

      <section className="rounded-2xl border border-nq-border bg-nq-surface p-6">
        <h2 className="text-sm font-semibold text-nq-foreground">
          Operator checklist
        </h2>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-nq-muted">
          <li>
            Review tenant exceptions and scoped controls from Salons.
          </li>
          <li>
            Investigate incidents and recent operator actions before changing a
            platform flag.
          </li>
          <li>
            Treat announcements as drafts until recipients, language, approval,
            and delivery evidence are confirmed.
          </li>
          <li>
            Use AI Ops to inspect runtime proof and cost; an “Open tool” link is
            not a certification result.
          </li>
        </ul>
      </section>
    </main>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  const display = value === null ? "—" : value.toLocaleString();
  return (
    <div
      data-testid="superadmin-stat-card"
      data-label={label}
      className="flex flex-col gap-2 rounded-2xl border border-nq-border bg-nq-surface p-5"
    >
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-nq-muted">
        {label}
      </p>
      <p className="font-mono text-3xl font-semibold tabular-nums text-nq-foreground">
        {display}
      </p>
    </div>
  );
}
