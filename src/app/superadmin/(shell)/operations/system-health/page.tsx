import { loadErrorLogs } from "@/shared/superadmin/errorMonitorActions";
import { ErrorMonitorClient } from "@/components/superadmin/ErrorMonitorClient";
import {
  loadCronOperatingState,
  type CronRouteHealth,
} from "@/shared/operations/cronOperatingState";

export const dynamic = "force-dynamic";

const STATUS_STYLE: Record<CronRouteHealth["status"], string> = {
  healthy: "border-nq-success/40 bg-nq-success/10 text-nq-success",
  running: "border-nq-primary/40 bg-nq-primary/10 text-nq-primary",
  failed: "border-nq-error/40 bg-nq-error/10 text-nq-error",
  stale: "border-nq-warning/40 bg-nq-warning/10 text-nq-warning",
  pending: "border-nq-muted/40 bg-nq-muted/10 text-nq-muted",
  missing: "border-nq-warning/40 bg-nq-warning/10 text-nq-warning",
};

function formatTimestamp(value: string | null) {
  if (!value) return "Never observed";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Invalid timestamp";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Vancouver",
  }).format(new Date(timestamp));
}

/**
 * `/superadmin/operations/system-health` — self-hosted error monitor.
 * Auth + superadmin gate runs in `(shell)/layout.tsx`.
 */
export default async function SystemHealthPage() {
  const [result, cronHealth] = await Promise.all([
    loadErrorLogs("open"),
    loadCronOperatingState().catch(() => null),
  ]);
  const cronIssues =
    cronHealth?.filter(
      (worker) =>
        worker.status !== "healthy" &&
        worker.status !== "running" &&
        worker.status !== "pending",
    ).length ?? null;
  const cronPending =
    cronHealth?.filter((worker) => worker.status === "pending").length ?? null;
  const cronHealthy =
    cronHealth?.filter(
      (worker) => worker.status === "healthy" || worker.status === "running",
    ).length ?? null;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
        System Health
      </h1>
      <p className="mt-2 text-sm text-nq-muted">
        Scheduler liveness and application errors from NailIQ&apos;s own
        operating record.
      </p>

      <section className="mt-6 rounded-2xl border border-nq-border/40 bg-nq-surface/35 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-nq-foreground">
              Scheduled workers
            </h2>
            <p className="mt-1 text-xs text-nq-muted">
              Every authorized cron run must record a fenced start and terminal
              outcome.
            </p>
          </div>
          {cronIssues !== null ? (
            <span
              className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                cronIssues === 0
                  ? STATUS_STYLE.healthy
                  : STATUS_STYLE.failed
              }`}
            >
              {[
                cronIssues ? `${cronIssues} need attention` : null,
                cronHealthy ? `${cronHealthy} healthy` : null,
                cronPending ? `${cronPending} awaiting first run` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
        </div>

        {!cronHealth ? (
          <p className="mt-4 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
            Scheduler operating state is unavailable.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-nq-muted">
                <tr className="border-b border-nq-border/35">
                  <th className="px-2 py-2 font-semibold">Worker</th>
                  <th className="px-2 py-2 font-semibold">Schedule</th>
                  <th className="px-2 py-2 font-semibold">State</th>
                  <th className="px-2 py-2 font-semibold">Last start</th>
                  <th className="px-2 py-2 font-semibold">Last error</th>
                </tr>
              </thead>
              <tbody>
                {cronHealth.map((worker) => (
                  <tr
                    key={worker.workerName}
                    className="border-b border-nq-border/20 last:border-0"
                  >
                    <td className="px-2 py-3 font-medium text-nq-foreground">
                      {worker.label}
                    </td>
                    <td className="px-2 py-3 text-nq-muted">
                      {worker.schedule}
                    </td>
                    <td className="px-2 py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLE[worker.status]}`}
                      >
                        {worker.status}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-nq-muted">
                      {worker.status === "pending"
                        ? "Awaiting first scheduled run"
                        : formatTimestamp(worker.lastStartedAt)}
                    </td>
                    <td className="px-2 py-3 font-mono text-xs text-nq-muted">
                      {worker.lastError ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold text-nq-foreground">
          Application errors
        </h2>
        <p className="mt-1 text-xs text-nq-muted">
          Identical errors are grouped; the counter shows how often each
          occurred.
        </p>
      {!result.ok ? (
        <p className="mt-6 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          Failed to load errors ({result.error}). Check SUPABASE_SERVICE_ROLE_KEY
          and the migration state.
        </p>
      ) : (
        <ErrorMonitorClient initialRows={result.rows} />
      )}
      </section>
    </main>
  );
}
