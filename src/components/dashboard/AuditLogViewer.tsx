"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import {
  loadAuditLog,
  type AuditLogRow,
  type LoadAuditLogResult,
} from "@/shared/dashboard/loadAuditLogAction";
import type { ReceptionistMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";

/**
 * Owner-only audit log viewer rendered in Settings. Reads the most
 * recent 50 booking events for the salon. Loads lazily on mount via
 * `loadAuditLog` (a server action that gates on `role === "owner"`).
 *
 * Per `PERMISSION_MATRIX §3` the action will refuse to serve senior /
 * nail_tech viewers; the UI also short-circuits via the parent route
 * (Settings page is owner-resolvable).
 */

export interface AuditLogViewerProps {
  slug: string;
  messages: ReceptionistMessages["auditLog"];
}

const ACTOR_BADGE_VARIANT: Record<
  string,
  "info" | "neutral" | "warning" | "vip"
> = {
  owner: "info",
  senior: "info",
  nail_tech: "neutral",
  manager: "info",
  trainee: "neutral",
  viewer: "neutral",
  accounting: "neutral",
  public_guest: "neutral",
  demo_cookie: "warning",
  system: "warning",
};

function formatTimestamp(iso: string): string {
  // Locale-default formatting; the audit viewer is owner-facing and
  // doesn't ride salon timezone (owners may live in a different zone
  // than the floor). Keep it simple — full local datetime.
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  return d.toLocaleString("en-US");
}

function eventSummary(
  row: AuditLogRow,
  m: ReceptionistMessages["auditLog"],
): string {
  const name = row.clientName?.trim() || m.unknownGuest;
  switch (row.eventType) {
    case "booking_created":
      return m.summaries.booking_created.replace("{name}", name);
    case "booking_edited":
      return m.summaries.booking_edited.replace("{name}", name);
    case "booking_cancelled":
      return m.summaries.booking_cancelled.replace("{name}", name);
    case "booking_status_changed": {
      const from =
        typeof row.payload.from === "string" ? row.payload.from : "?";
      const to = typeof row.payload.to === "string" ? row.payload.to : "?";
      // P0.9 — Prefer transition-specific phrasing ("Started service
      // for {name}") when the salon has localized copy for that
      // exact {from}_to_{to} pair. Otherwise fall back to the
      // generic template with localized status names so the
      // operator never sees raw `confirmed`/`in_progress` codes.
      const transitionKey = `${from}_to_${to}`;
      const tmpl = m.statusTransitions[transitionKey];
      if (tmpl) return tmpl.replace("{name}", name);
      const fromLabel = m.statusNames[from] ?? from;
      const toLabel = m.statusNames[to] ?? to;
      return m.summaries.booking_status_changed
        .replace("{name}", name)
        .replace("{from}", fromLabel)
        .replace("{to}", toLabel);
    }
    case "walkin_added":
      return m.summaries.walkin_added.replace("{name}", name);
    case "addon_added":
      return m.summaries.addon_added.replace("{name}", name);
    case "queue_joined":
      return m.summaries.queue_joined.replace("{name}", name);
    case "queue_assigned":
      return m.summaries.queue_assigned.replace("{name}", name);
    case "queue_left":
      return m.summaries.queue_left.replace("{name}", name);
    case "soft_hold_set":
      return m.summaries.soft_hold_set.replace("{name}", name);
    case "soft_hold_expired":
      return m.summaries.soft_hold_expired.replace("{name}", name);
    default:
      return row.eventType;
  }
}

export function AuditLogViewer({ slug, messages }: AuditLogViewerProps) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; rows: AuditLogRow[] }
    | { kind: "error"; error: Extract<LoadAuditLogResult, { ok: false }>["error"] }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await loadAuditLog(slug);
      if (cancelled) return;
      if (res.ok) {
        setState({ kind: "ok", rows: res.rows });
      } else {
        setState({ kind: "error", error: res.error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const errorCopy = useMemo(() => {
    if (state.kind !== "error") return null;
    return messages.errors[state.error] ?? messages.errors.server_error;
  }, [state, messages]);

  return (
    <Card variant="default" padding="md">
      <div className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-nq-foreground">
            {messages.sectionTitle}
          </h2>
          <p className="mt-1 text-xs text-nq-muted">{messages.sectionIntro}</p>
        </div>

        {state.kind === "loading" ? (
          <p className="text-sm text-nq-muted" role="status">
            {messages.loading}
          </p>
        ) : null}

        {state.kind === "error" ? (
          <p
            className="rounded-md border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-sm text-nq-error"
            role="alert"
            data-testid="audit-log-error"
          >
            {errorCopy}
          </p>
        ) : null}

        {state.kind === "ok" && state.rows.length === 0 ? (
          <p className="text-sm italic text-nq-muted">{messages.empty}</p>
        ) : null}

        {state.kind === "ok" && state.rows.length > 0 ? (
          <ul
            data-testid="audit-log-list"
            className="divide-y divide-nq-border/50"
          >
            {state.rows.map((row) => (
              <li
                key={row.id}
                data-testid={`audit-log-row-${row.id}`}
                className={cn(
                  "flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:gap-3",
                )}
              >
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-nq-muted sm:w-44">
                  {formatTimestamp(row.createdAt)}
                </span>
                <Badge
                  variant={ACTOR_BADGE_VARIANT[row.actorRole] ?? "neutral"}
                  state="subtle"
                  size="sm"
                >
                  {messages.actorRoles[row.actorRole] ?? row.actorRole}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm text-nq-foreground">
                  {eventSummary(row, messages)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
