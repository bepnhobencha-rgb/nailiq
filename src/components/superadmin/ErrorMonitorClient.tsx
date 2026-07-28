"use client";

import { useState, useTransition } from "react";
import { assessErrorEvidence } from "@/shared/observability/errorEvidence";
import {
  loadErrorLogs,
  setErrorStatus,
  triageErrorNow,
  draftFixNow,
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

function formatContext(context: Record<string, unknown> | null): string | null {
  if (!context || Object.keys(context).length === 0) return null;
  try {
    return JSON.stringify(context, null, 2);
  } catch {
    return "[Context could not be serialized]";
  }
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

  function triage(id: string) {
    startTransition(async () => {
      await triageErrorNow(id);
      const r = await loadErrorLogs(filter);
      if (r.ok) setRows(r.rows);
    });
  }

  function fix(id: string) {
    startTransition(async () => {
      await draftFixNow(id);
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
                  {assessErrorEvidence(r.route, r.context).status === "conflict" ? (
                    <p className="mt-2 rounded-md border border-nq-warning/35 bg-nq-warning/10 px-2.5 py-2 text-xs text-nq-warning">
                      Evidence conflict: this legacy group combines different
                      routes. AI triage and draft fixes are blocked until a new
                      route-scoped occurrence is captured.
                    </p>
                  ) : null}
                  {r.fix_proposal ? (
                    <p className="mt-2 rounded-md bg-nq-success/10 px-2.5 py-1.5 text-xs text-nq-foreground">
                      ✨ <span className="font-semibold">AI fix:</span> {r.fix_proposal}
                      {r.fix_file ? (
                        <span className="ml-1 font-mono text-[11px] text-nq-muted">({r.fix_file})</span>
                      ) : null}
                    </p>
                  ) : null}
                  {r.fix_pr_url ? (
                    <a
                      href={r.fix_pr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-xs font-semibold text-nq-info hover:underline"
                    >
                      → Review draft PR
                    </a>
                  ) : null}
                  {r.stack || formatContext(r.context) ? (
                    <details className="mt-3 rounded-lg border border-nq-muted/20 bg-nq-bg/40">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-nq-muted hover:text-nq-foreground">
                        Technical evidence
                      </summary>
                      <div className="space-y-3 border-t border-nq-muted/20 px-3 py-3">
                        {r.stack ? (
                          <div>
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-nq-muted">
                              Stack
                            </p>
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/25 p-2 font-mono text-[11px] leading-relaxed text-nq-foreground">
                              {r.stack}
                            </pre>
                          </div>
                        ) : null}
                        {formatContext(r.context) ? (
                          <div>
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-nq-muted">
                              Context
                            </p>
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/25 p-2 font-mono text-[11px] leading-relaxed text-nq-foreground">
                              {formatContext(r.context)}
                            </pre>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  {r.status === "open" ? (
                    <>
                      {!r.ai_summary &&
                      assessErrorEvidence(r.route, r.context).status !== "conflict" ? (
                        <button
                          onClick={() => triage(r.id)}
                          className="rounded-md bg-nq-info/15 px-2.5 py-1 text-xs text-nq-info hover:bg-nq-info/25"
                        >
                          🧠 Triage
                        </button>
                      ) : null}
                      {!r.fix_pr_url &&
                      assessErrorEvidence(r.route, r.context).status !== "conflict" ? (
                        <button
                          onClick={() => fix(r.id)}
                          className="rounded-md bg-nq-primary/15 px-2.5 py-1 text-xs text-nq-primary hover:bg-nq-primary/25"
                        >
                          ✨ Draft fix
                        </button>
                      ) : null}
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
