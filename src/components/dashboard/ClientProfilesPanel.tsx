"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import {
  loadClientProfiles,
  updateClientProfile,
  type ClientProfileRow,
  type LoadClientProfilesResult,
} from "@/shared/dashboard/loadClientProfilesAction";
import type { ReceptionistMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { formatPhone } from "@/shared/lib/phoneFormat";
import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";

/**
 * Client profiles panel — searchable list of recent clients with an
 * expanding detail row. Owner+senior can view; only owner can flip the
 * VIP toggle (server action enforces).
 *
 * Search filters client-side because the server returns at most 50
 * rows; full-text search is a follow-up.
 */

export interface ClientProfilesPanelProps {
  slug: string;
  viewerRole: SalonMemberRole;
  messages: ReceptionistMessages["clientProfiles"];
}

function formatLastVisit(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleDateString();
}

function formatDollars(cents: number): string {
  if (!Number.isFinite(cents)) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

export function ClientProfilesPanel({
  slug,
  viewerRole,
  messages,
}: ClientProfilesPanelProps) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; rows: ClientProfileRow[] }
    | { kind: "error"; error: Extract<LoadClientProfilesResult, { ok: false }>["error"] }
  >({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await loadClientProfiles(slug);
      if (cancelled) return;
      if (res.ok) setState({ kind: "ok", rows: res.rows });
      else setState({ kind: "error", error: res.error });
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const filtered = useMemo(() => {
    if (state.kind !== "ok") return [];
    const q = search.trim().toLowerCase();
    if (q.length === 0) return state.rows;
    return state.rows.filter((r) => {
      return (
        (r.name?.toLowerCase().includes(q) ?? false) ||
        r.phone.toLowerCase().includes(q)
      );
    });
  }, [state, search]);

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

        <input
          type="search"
          data-testid="client-profiles-search"
          placeholder={messages.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={cn(
            "h-10 w-full rounded-lg border border-nq-border bg-nq-bg px-3 text-sm text-nq-foreground placeholder:text-nq-muted",
            "focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
          )}
        />

        {state.kind === "loading" ? (
          <p role="status" className="text-sm text-nq-muted">
            {messages.loading}
          </p>
        ) : null}

        {state.kind === "error" ? (
          <p
            role="alert"
            data-testid="client-profiles-error"
            className="rounded-md border border-nq-error/40 bg-nq-error/10 px-3 py-2 text-sm text-nq-error"
          >
            {errorCopy}
          </p>
        ) : null}

        {state.kind === "ok" && filtered.length === 0 ? (
          <p className="text-sm italic text-nq-muted">{messages.empty}</p>
        ) : null}

        {state.kind === "ok" && filtered.length > 0 ? (
          <ul
            data-testid="client-profiles-list"
            className="divide-y divide-nq-border/50"
          >
            {filtered.map((row) => {
              const isOpen = expanded === row.phone;
              return (
                <ClientRow
                  key={row.id}
                  row={row}
                  isOpen={isOpen}
                  onToggleOpen={() =>
                    setExpanded((cur) => (cur === row.phone ? null : row.phone))
                  }
                  canEditVip={viewerRole === "owner"}
                  slug={slug}
                  messages={messages}
                  onVipChanged={(next) => {
                    setState((prev) => {
                      if (prev.kind !== "ok") return prev;
                      return {
                        kind: "ok",
                        rows: prev.rows.map((r) =>
                          r.phone === row.phone ? { ...r, isVip: next } : r,
                        ),
                      };
                    });
                  }}
                />
              );
            })}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}

function ClientRow({
  row,
  isOpen,
  onToggleOpen,
  canEditVip,
  slug,
  messages,
  onVipChanged,
}: {
  row: ClientProfileRow;
  isOpen: boolean;
  onToggleOpen: () => void;
  canEditVip: boolean;
  slug: string;
  messages: ReceptionistMessages["clientProfiles"];
  onVipChanged: (next: boolean) => void;
}) {
  const [vipPending, startVipTransition] = useTransition();
  const [vipError, setVipError] = useState<string | null>(null);
  const phoneDisplay = formatPhone(row.phone) ?? row.phone;

  return (
    <li
      data-testid={`client-row-${row.phone}`}
      className="flex flex-col gap-2 py-2.5"
    >
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        className={cn(
          "flex flex-col gap-0.5 rounded-md px-1 py-1 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
        )}
      >
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-nq-foreground">
            {row.name?.trim() || messages.unknownName}
          </span>
          {row.isVip ? (
            <Badge variant="vip" state="default" size="sm">
              {messages.vipBadge}
            </Badge>
          ) : null}
        </span>
        <span className="font-mono text-[11px] text-nq-muted">
          {phoneDisplay}
        </span>
        <span className="text-[11px] text-nq-muted">
          {messages.summaryLine
            .replace("{visits}", String(row.visitCount))
            .replace("{lastVisit}", formatLastVisit(row.lastVisitAt))}
        </span>
      </button>

      {isOpen ? (
        <div
          data-testid={`client-detail-${row.phone}`}
          className="space-y-2 rounded-md border border-nq-border/50 bg-nq-surface/60 p-3 text-sm"
        >
          <p>
            <span className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
              {messages.totalSpent}
            </span>{" "}
            <span className="font-medium text-nq-foreground">
              {formatDollars(row.totalSpentCents)}
            </span>
          </p>

          {row.email ? (
            <p>
              <span className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
                {messages.email}
              </span>{" "}
              <span className="text-nq-foreground">{row.email}</span>
            </p>
          ) : null}

          {row.notes?.trim() ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
                {messages.notes}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-nq-foreground/95">
                {row.notes}
              </p>
            </div>
          ) : (
            <p className="italic text-nq-muted">{messages.noNotes}</p>
          )}

          {canEditVip ? (
            <div className="flex flex-col gap-1 pt-1">
              <Toggle
                checked={row.isVip}
                onChange={(next) => {
                  setVipError(null);
                  startVipTransition(async () => {
                    const res = await updateClientProfile(slug, {
                      phone: row.phone,
                      isVip: next,
                    });
                    if (res.ok) {
                      onVipChanged(next);
                    } else {
                      setVipError(
                        messages.vipUpdateErrors[res.error] ??
                          messages.vipUpdateErrors.server_error,
                      );
                    }
                  });
                }}
                disabled={vipPending}
                loading={vipPending}
                label={messages.vipLabel}
                description={messages.vipHint}
              />
              {vipError ? (
                <p
                  role="alert"
                  className="text-xs text-nq-error"
                  data-testid={`client-vip-error-${row.phone}`}
                >
                  {vipError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
