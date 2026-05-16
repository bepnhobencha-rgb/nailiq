import type { Metadata } from "next";
import { AuditLogPager } from "@/components/superadmin/AuditLogPager";
import { AuditLogTable } from "@/components/superadmin/AuditLogTable";
import { loadSuperadminAuditLogs } from "@/shared/superadmin/auditLogActions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Audit logs · NailIQ SuperAdmin" },
  robots: { index: false, follow: false },
};

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
  const cursorParam = params.cursor;
  const cursor = Array.isArray(cursorParam) ? cursorParam[0] : cursorParam;

  const result = await loadSuperadminAuditLogs({}, cursor ?? null);

  if (!result.ok) {
    const message =
      result.error === "forbidden"
        ? "Your role does not have access to the audit log."
        : result.error === "unauthorized"
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

  // Build a flat record of the page's searchParams so the pager can
  // preserve them across navigation. (Filters land in step 5.)
  const baseParams: Record<string, string | undefined> = {};

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

      <AuditLogTable rows={result.rows} />

      <AuditLogPager
        basePath="/superadmin/support/audit-logs"
        baseSearchParams={baseParams}
        nextCursor={result.nextCursor}
        prevCursor={result.prevCursor}
      />
    </main>
  );
}
