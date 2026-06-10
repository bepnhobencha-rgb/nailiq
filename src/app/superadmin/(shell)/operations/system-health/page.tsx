import { loadErrorLogs } from "@/shared/superadmin/errorMonitorActions";
import { ErrorMonitorClient } from "@/components/superadmin/ErrorMonitorClient";

export const dynamic = "force-dynamic";

/**
 * `/superadmin/operations/system-health` — self-hosted error monitor.
 * Auth + superadmin gate runs in `(shell)/layout.tsx`.
 */
export default async function SystemHealthPage() {
  const result = await loadErrorLogs("open");

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
        System Health — Errors
      </h1>
      <p className="mt-2 text-sm text-nq-muted">
        Live application errors captured in-house (no third party). Identical
        errors are grouped; the counter is how many times each has happened.
      </p>

      {!result.ok ? (
        <p className="mt-6 rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error">
          Failed to load errors ({result.error}). Check SUPABASE_SERVICE_ROLE_KEY
          and the migration state.
        </p>
      ) : (
        <ErrorMonitorClient initialRows={result.rows} />
      )}
    </main>
  );
}
