"use client";

import { useCallback, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import {
  loadDeletedRecordsForSalon,
  restoreSalonRecord,
} from "@/shared/superadmin/superadminActions";
import type { DeletedRecord } from "@/shared/superadmin/superadminTypes";

/**
 * Per-salon "Show deleted" expander — soft-deleted services + staff
 * with a Restore button each. Lazy-loads on first open so the page
 * render isn't gated on the count query.
 *
 * Extracted from `SuperAdminPanel.tsx` so the detail page
 * (`/superadmin/salons/[salonId]`) can reuse it without pulling in
 * the legacy panel shell.
 */
export function DeletedRecordsSection({ salonId }: { salonId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<DeletedRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    startTransition(async () => {
      const result = await loadDeletedRecordsForSalon(salonId);
      setLoading(false);
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setRecords(result.records);
    });
  }, [salonId]);

  const onToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next && records.length === 0 && !loading && !loadError) {
        refresh();
      }
      return next;
    });
  }, [records.length, loading, loadError, refresh]);

  const onRestore = useCallback((rec: DeletedRecord) => {
    const key = `${rec.table}:${rec.id}`;
    setBusyKey(key);
    startTransition(async () => {
      const result = await restoreSalonRecord(rec.table, rec.id);
      setBusyKey((cur) => (cur === key ? null : cur));
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setRecords((cur) =>
        cur.filter((r) => !(r.id === rec.id && r.table === rec.table)),
      );
    });
  }, []);

  return (
    <div className="rounded-xl border border-nq-border/30 bg-nq-bg/40 p-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left text-xs font-semibold text-nq-muted transition-colors hover:text-nq-foreground"
      >
        <span className="uppercase tracking-[0.14em]">
          {open ? "Hide" : "Show"} deleted records
        </span>
        <span className="font-mono text-[10px] text-nq-muted/70">
          {open && records.length > 0 ? `${records.length} hidden` : null}
        </span>
      </button>

      {open ? (
        <div className="mt-3">
          {loading ? (
            <p className="text-xs text-nq-muted">Loading…</p>
          ) : loadError ? (
            <p className="text-xs text-nq-error">Error: {loadError}</p>
          ) : records.length === 0 ? (
            <p className="text-xs text-nq-muted">No deleted records.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {records.map((rec) => {
                const key = `${rec.table}:${rec.id}`;
                const busy = busyKey === key;
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-2 rounded-md border border-nq-border/40 bg-nq-surface/40 px-2.5 py-1.5"
                  >
                    <div className="min-w-0 text-xs">
                      <span className="mr-2 inline-block rounded bg-nq-surface/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-nq-muted">
                        {rec.table}
                      </span>
                      <span className="font-medium text-nq-foreground">
                        {rec.label}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => onRestore(rec)}
                    >
                      {busy ? "Restoring…" : "Restore"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
