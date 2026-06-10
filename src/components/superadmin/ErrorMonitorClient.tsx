"use client";

import { useState, useTransition } from "react";
import {
  loadErrorLogs,
  setErrorStatus,
  type ErrorLogRow,
} from "@/shared/superadmin/errorMonitorActions";

const LEVEL_STYLE: Record<string, string> = {
  fatal: "bg-nq-error/20 text-nq-error border-nq-error/40",
  error: "bg-nq-error/10 text-nq-error border-nq-error/30",
  warning: "bg-nq-warning/15 text-nq-warning border-nq-warning/35",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function ErrorMonitorClient({ initialRows }: { initialRows: ErrorLogRow[] }) {
  const [rows, setRows] = useState<ErrorLogRow[]>(initialRows);
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  const [pending, startTransition] = useTransition();

  function refresh(next: "open" | "resolved" | "all") {
    setFilter(next);
    startTransition(async () => {
      const r = await loadErrorLogs(next);
      if (r.ok) setRows(r.rows);
    });
  }

  function act(id: string, status: "resolved" | "ignored" | "open") {
    startTransition(async () => {
      await setErrorStatus(id, status);
      const r = await loadErrorLogs(filter);
      if (r.ok) setRows(r.rows);
    });
  }

  return (
    <div className="mt-6">
      <div className="mb-4 flex items-center gap-2">
        {(["open", "resolved", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => refresh(f)}
            className={`rounded-full border px-3 py-1 text-xs capitalize transition ${
              filter === f
                ? "border-nq-primary bg-nq-primary/15 text-nq-foreground"
                : "border-nq-muted/30 text-nq-muted hover:text-nq-foreground"
            }`}
          >
            {f}
          </button>
        ))}
        {pending ? <span className="text-xs text-nq-muted">updating…</span> : null}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-nq-muted/25 bg-nq-surface px-4 py-8 text-center text-sm text-nq-muted">
          🎉 No {filter === "all" ? "" : filter} errors.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-xl border border-nq-muted/25 bg-nq-surface p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                        LEVEL_STYLE[r.level] ?? LEVEL_STYLE.error
                      }`}
                    >
                      {r.level}
                    </span>
                    {r.surface ? (
                      <span className="rounded bg-nq-muted/15 px-1.5 py-0.5 text-[10px] text-nq-muted">
                        {r.surface}
                      </span>
                    ) : null}
                    <span className="text-[11px] font-semibold text-nq-foreground">
                      ×{r.occurrence_count}
                    </span>
                    <span className="text-[11px] text-nq-muted">
                      last {timeAgo(r.last_seen_at)} · first {timeAgo(r.first_seen_at)}
                    </span>
                  </div>
                  <p className="truncate text-sm font-medium text-nq-foreground" title={r.message}>
                    {r.message}
                  </p>
                  {r.route ? (
                    <p className="mt-0.5 font-mono text-[11px] text-nq-muted">{r.route}</p>
                  ) : null}
                  {r.ai_summary ? (
                    <p className="mt-2 rounded-md bg-nq-info/10 px-2.5 py-1.5 text-xs text-nq-foreground">
                      🧠 {r.ai_summary}
                    </p>
                  ) : null}
                  {r.ai_suggested_fix ? (
                    <p className="mt-1 text-xs text-nq-muted">
                      <span className="font-semibold">Fix:</span> {r.ai_suggested_fix}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  {r.status === "open" ? (
                    <>
                      <button
                        onClick={() => act(r.id, "resolved")}
                        className="rounded-md bg-nq-success/15 px-2.5 py-1 text-xs text-nq-success hover:bg-nq-success/25"
                      >
                        Resolve
                      </button>
                      <button
                        onClick={() => act(r.id, "ignored")}
                        className="rounded-md px-2.5 py-1 text-xs text-nq-muted hover:text-nq-foreground"
                      >
                        Ignore
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => act(r.id, "open")}
                      className="rounded-md px-2.5 py-1 text-xs text-nq-muted hover:text-nq-foreground"
                    >
                      Reopen
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
