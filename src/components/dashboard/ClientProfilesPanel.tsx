"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import { Badge } from "@/components/ui/Badge";
import { Toggle } from "@/components/ui/Toggle";
import {
  loadClientProfiles,
  updateClientProfile,
  type ClientProfileRow,
  type LoadClientProfilesResult,
} from "@/shared/dashboard/loadClientProfilesAction";
import {
  getUserMessages,
  type ReceptionistMessages,
  type UserLanguage,
} from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { formatPhone } from "@/shared/lib/phoneFormat";
import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

/**
 * Client profiles panel — segmented, card-based directory of recent
 * clients. Owner+senior+admin+receptionist can view; only owner can flip
 * the VIP toggle (server action enforces).
 *
 * Search filters client-side because the server returns at most 50
 * rows; full-text search is a follow-up. Cards are bucketed into
 * lifecycle segments (VIP / new / regular / at-risk) so staff can see
 * who to court without scanning a flat list.
 */

export interface ClientProfilesPanelProps {
  slug: string;
  viewerRole: SalonMemberRole;
}

/** A client is "at risk" once this many days pass since their last visit. */
const AT_RISK_DAYS = 60;
const PAGE_SIZE = 24;

type Segment = "vip" | "new" | "regular" | "atRisk";
type SegmentFilter = "all" | Segment;

/**
 * Assign each client to exactly ONE lifecycle bucket so the chip counts
 * sum to the total. Priority: VIP > new > at-risk > regular.
 */
function clientSegment(row: ClientProfileRow, nowMs: number): Segment {
  if (row.isVip) return "vip";
  if (row.visitCount <= 1) return "new";
  const lastMs = row.lastVisitAt ? Date.parse(row.lastVisitAt) : NaN;
  const daysSince = Number.isFinite(lastMs)
    ? (nowMs - lastMs) / 86_400_000
    : Infinity;
  if (daysSince > AT_RISK_DAYS) return "atRisk";
  return "regular";
}

/** Up-to-two-letter initials from a name; "?" when unnamed. */
function initialsOf(name: string | null): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : "";
  return (first + last).toUpperCase() || "?";
}

function formatLastVisit(iso: string | null, language: UserLanguage): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  // VI: DD/M/YYYY (no zero-padding, matches "13/5/2026" spec).
  // EN: locale-default (US-style M/D/YYYY for English browsers).
  if (language === "vi") {
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  }
  return d.toLocaleDateString();
}

function formatDollars(cents: number): string {
  if (!Number.isFinite(cents)) return "$0.00";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Compact dollar label for the card stat row ("$1.2k", "$340"). */
function formatDollarsCompact(cents: number): string {
  const dollars = Math.round((cents || 0) / 100);
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${dollars}`;
}

const SEGMENT_BADGE: Record<
  Segment,
  "vip" | "info" | "neutral" | "warning"
> = {
  vip: "vip",
  new: "info",
  regular: "neutral",
  atRisk: "warning",
};

export function ClientProfilesPanel({
  slug,
  viewerRole,
}: ClientProfilesPanelProps) {
  const { language } = useUserLanguage();
  const messages = useMemo(
    () => getUserMessages(language).receptionist.clientProfiles,
    [language],
  );
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; rows: ClientProfileRow[] }
    | { kind: "error"; error: Extract<LoadClientProfilesResult, { ok: false }>["error"] }
  >({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

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

  // Stable "now" for the lifetime of a render pass so segment counts and
  // card buckets agree. Recomputed whenever the rows reference changes.
  const rows = state.kind === "ok" ? state.rows : null;
  const segmentOf = useMemo(() => {
    const nowMs = Date.now();
    const map = new Map<string, Segment>();
    for (const r of rows ?? []) map.set(r.phone, clientSegment(r, nowMs));
    return map;
  }, [rows]);

  const counts = useMemo(() => {
    const c: Record<SegmentFilter, number> = {
      all: rows?.length ?? 0,
      vip: 0,
      new: 0,
      regular: 0,
      atRisk: 0,
    };
    for (const seg of segmentOf.values()) c[seg] += 1;
    return c;
  }, [rows, segmentOf]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (segment !== "all" && segmentOf.get(r.phone) !== segment) return false;
      if (q.length === 0) return true;
      return (
        (r.name?.toLowerCase().includes(q) ?? false) ||
        r.phone.toLowerCase().includes(q)
      );
    });
  }, [rows, search, segment, segmentOf]);

  // Reset pagination when the filter set changes so "Show more" always
  // starts from the top of the new result set.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, segment]);

  const visible = filtered.slice(0, visibleCount);

  const errorCopy = useMemo(() => {
    if (state.kind !== "error") return null;
    return messages.errors[state.error] ?? messages.errors.server_error;
  }, [state, messages]);

  const segmentChips: { key: SegmentFilter; label: string }[] = [
    { key: "all", label: messages.segments.all },
    { key: "vip", label: messages.segments.vip },
    { key: "new", label: messages.segments.new },
    { key: "regular", label: messages.segments.regular },
    { key: "atRisk", label: messages.segments.atRisk },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
            {messages.pageTitle}
          </h1>
          <p className="mt-1 text-sm text-nq-muted">{messages.sectionIntro}</p>
        </div>
        {state.kind === "ok" ? (
          <span className="text-sm text-nq-muted">
            {messages.countLabel(visible.length, filtered.length)}
          </span>
        ) : null}
      </header>

      <div className="space-y-3">
        <input
          type="search"
          data-testid="client-profiles-search"
          placeholder={messages.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={cn(
            "h-11 w-full rounded-xl border border-nq-border bg-nq-surface/60 px-4 text-sm text-nq-foreground placeholder:text-nq-muted",
            "transition-shadow focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
          )}
        />

        {state.kind === "ok" && rows && rows.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter clients">
            {segmentChips.map((chip) => {
              const active = segment === chip.key;
              const n = counts[chip.key];
              if (chip.key !== "all" && n === 0) return null;
              return (
                <button
                  key={chip.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`client-segment-${chip.key}`}
                  onClick={() => setSegment(chip.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium",
                    "transition-colors duration-[var(--duration-nq-fast)]",
                    active
                      ? "border-nq-primary/50 bg-nq-primary/15 text-nq-primary"
                      : "border-nq-border/50 bg-nq-surface/40 text-nq-muted hover:text-nq-foreground",
                  )}
                >
                  {chip.label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[10px] tabular-nums",
                      active ? "bg-nq-primary/20" : "bg-nq-bg/60",
                    )}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {state.kind === "loading" ? (
        <div
          role="status"
          aria-label={messages.loading}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-[112px] animate-pulse rounded-2xl border border-nq-border/40 bg-nq-surface/40"
            />
          ))}
        </div>
      ) : null}

      {state.kind === "error" ? (
        <p
          role="alert"
          data-testid="client-profiles-error"
          className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
        >
          {errorCopy}
        </p>
      ) : null}

      {state.kind === "ok" && filtered.length === 0 ? (
        <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/30 px-6 py-12 text-center">
          <p className="text-sm text-nq-muted">{messages.empty}</p>
        </div>
      ) : null}

      {state.kind === "ok" && visible.length > 0 ? (
        <>
          <ul
            data-testid="client-profiles-list"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            {visible.map((row) => (
              <ClientCard
                key={row.id}
                row={row}
                segment={segmentOf.get(row.phone) ?? "regular"}
                isOpen={expanded === row.phone}
                onToggleOpen={() =>
                  setExpanded((cur) => (cur === row.phone ? null : row.phone))
                }
                canEditVip={viewerRole === "owner"}
                slug={slug}
                messages={messages}
                language={language}
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
            ))}
          </ul>

          {visibleCount < filtered.length ? (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className={cn(
                  "rounded-full border border-nq-border bg-nq-surface/60 px-5 py-2 text-sm font-medium text-nq-foreground",
                  "transition-colors hover:border-nq-primary/40 hover:text-nq-primary",
                )}
              >
                {messages.loadMore}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ClientCard({
  row,
  segment,
  isOpen,
  onToggleOpen,
  canEditVip,
  slug,
  messages,
  language,
  onVipChanged,
}: {
  row: ClientProfileRow;
  segment: Segment;
  isOpen: boolean;
  onToggleOpen: () => void;
  canEditVip: boolean;
  slug: string;
  messages: ReceptionistMessages["clientProfiles"];
  language: UserLanguage;
  onVipChanged: (next: boolean) => void;
}) {
  const [vipPending, startVipTransition] = useTransition();
  const [vipError, setVipError] = useState<string | null>(null);
  const phoneDisplay = formatPhone(row.phone) ?? row.phone;
  const isVip = segment === "vip";
  const badgeLabel = messages.segments[segment];

  return (
    <li
      data-testid={`client-row-${row.phone}`}
      className={cn(
        "group flex flex-col rounded-2xl border bg-nq-surface/50 transition-colors",
        isOpen
          ? "border-nq-primary/40"
          : "border-nq-border/50 hover:border-nq-border",
      )}
    >
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        className={cn(
          "flex w-full flex-col gap-3 p-4 text-left",
          "focus-visible:outline-none focus-visible:rounded-2xl focus-visible:ring-2 focus-visible:ring-nq-primary/40",
        )}
      >
        <div className="flex items-start gap-3">
          {/* Initials avatar — gold ring + gold ink marks VIP, restraint
              keeps every other client a calm neutral disc. */}
          <span
            aria-hidden
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
              isVip
                ? "bg-nq-primary/15 text-nq-primary ring-1 ring-nq-primary/50"
                : "bg-nq-bg/70 text-nq-foreground ring-1 ring-nq-border/60",
            )}
          >
            {initialsOf(row.name)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-nq-foreground">
                {row.name?.trim() || messages.unknownName}
              </span>
              <Badge variant={SEGMENT_BADGE[segment]} state="default" size="sm">
                {badgeLabel}
              </Badge>
            </div>
            <span className="mt-0.5 block truncate font-mono text-[11px] text-nq-muted">
              {phoneDisplay}
            </span>
          </div>
        </div>

        {/* Compact stat row — visits · spend · last visit. */}
        <dl className="grid grid-cols-3 gap-2 border-t border-nq-border/40 pt-3">
          <Stat label={messages.statVisits} value={String(row.visitCount)} />
          <Stat
            label={messages.statSpent}
            value={formatDollarsCompact(row.totalSpentCents)}
          />
          <Stat
            label={messages.statLastVisit}
            value={formatLastVisit(row.lastVisitAt, language)}
          />
        </dl>
      </button>

      {isOpen ? (
        <div
          data-testid={`client-detail-${row.phone}`}
          className="space-y-2 border-t border-nq-border/40 px-4 py-3 text-sm"
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
            <p className="truncate">
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-nq-muted">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-nq-foreground">
        {value}
      </dd>
    </div>
  );
}
