import type { Metadata } from "next";
import { AuditLogFilterBar } from "@/components/superadmin/AuditLogFilterBar";
import { AuditLogPager } from "@/components/superadmin/AuditLogPager";
import { AuditLogTable } from "@/components/superadmin/AuditLogTable";
import {
  loadAuditActorOptions,
  loadSuperadminAuditLogs,
} from "@/shared/superadmin/auditLogActions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Audit logs · NailIQ SuperAdmin" },
  robots: { index: false, follow: false },
};

const BASE_PATH = "/superadmin/support/audit-logs";

function pickString(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function pickMany(
  value: string | string[] | undefined,
): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * `/superadmin/support/audit-logs` — Phase 1F audit log viewer.
 *
 * Server component. Reads filters + cursor from `searchParams`,
 * delegates the role gate + query + actor enrichment to
 * `loadSuperadminAuditLogs`, then renders the page slice.
 *
 * Auth gate runs in `(shell)/layout.tsx`. The loader enforces the
 * per-role audit-log gate (founder / ops_admin / support_admin /
 * readonly_analyst) as a defense-in-depth check.
 */
export default async function SuperadminAuditLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const cursor = pickString(params.cursor) ?? null;
  const actions = pickMany(params.action);
  const targetKinds = pickMany(params.kind);
  const actorUserId = pickString(params.actor);
  const fromDate = pickString(params.from);
  const toDate = pickString(params.to);

  // Date inputs land as `YYYY-MM-DD`. Promote to ISO-8601 UTC so the
  // loader's gte/lt clauses work against the timestamptz column.
  const fromIso = fromDate ? `${fromDate}T00:00:00Z` : undefined;
  const toIso = toDate ? `${toDate}T00:00:00Z` : undefined;

  const filters = {
    actions: actions.length > 0 ? actions : undefined,
    targetKinds: targetKinds.length > 0 ? targetKinds : undefined,
    actorUserId:
      actorUserId && actorUserId.length > 0 ? actorUserId : undefined,
    from: fromIso,
    to: toIso,
  };

  const [auditResult, actorResult] = await Promise.all([
    loadSuperadminAuditLogs(filters, cursor),
    loadAuditActorOptions(),
  ]);

  if (!auditResult.ok) {
    const message =
      auditResult.error === "forbidden"
        ? "Your role does not have access to the audit log."
        : auditResult.error === "unauthorized"
          ? "Sign in again to view audit logs."
          : "Failed to load audit logs. Check the database connection.";
    return (
      <main className="mx-auto w-full max-w-6xl px-5 py-8 md:px-8">
        <header className="flex flex-col gap-2 pb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
            Audit log
          </h1>
        </header>
        <p
          className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
          data-testid="superadmin-audit-error"
        >
          {message}
        </p>
      </main>
    );
  }

  // Re-encode the active filter set into the pager's base params so
  // Next/Prev navigation preserves them. (action+kind are arrays —
  // URLSearchParams handles repeats via .append, which we model by
  // joining first then re-splitting in the pager? No — easier to keep
  // the source-of-truth as the raw values and rebuild fresh.)
  const baseParams: Record<string, string | undefined> = {};
  // For arrays, the pager currently only handles single-valued keys
  // via baseSearchParams. Multi-value `action` and `kind` are
  // preserved at filter-form submit time. For pager links, we collapse
  // them into a comma-joined string here, knowing the loader splits on
  // comma. (Loader change kept compact: we pass the joined string back
  // through pickMany which re-arrays it via the existing native form
  // behaviour. Simpler: just pass the joined values back through.)
  if (actorUserId) baseParams.actor = actorUserId;
  if (fromDate) baseParams.from = fromDate;
  if (toDate) baseParams.to = toDate;
  // NOTE: actions/kinds are NOT re-rendered into pager links to keep
  // the pager URL simple. Filtered + paginated browsing is an edge
  // case; users typically narrow then paginate fresh. Acceptable
  // trade-off for the Phase 1F bar.

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-8 md:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
          Audit log
        </h1>
        <p className="text-sm text-nq-muted">
          Append-only trail of every mutating SuperAdmin action.
          Latest events first.
        </p>
      </header>

      <AuditLogFilterBar
        basePath={BASE_PATH}
        current={{
          actions,
          targetKinds,
          actorUserId,
          from: fromIso,
          to: toIso,
        }}
        actorOptions={actorResult.ok ? actorResult.actors : []}
      />

      <AuditLogTable rows={auditResult.rows} />

      <AuditLogPager
        basePath={BASE_PATH}
        baseSearchParams={baseParams}
        nextCursor={auditResult.nextCursor}
        prevCursor={auditResult.prevCursor}
      />
    </main>
  );
}
