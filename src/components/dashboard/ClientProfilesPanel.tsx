"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import { LayoutGrid, List, Table2 } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCardGrid } from "@/components/ui/Skeleton";
import { Toggle } from "@/components/ui/Toggle";
import { ClientProfile360Drawer } from "./ClientProfile360Drawer";
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
import { CLIENT_SEGMENT_DEFAULTS } from "@/shared/dashboard/clientSegmentSettings";
import { getHostStats, type HostStats } from "@/shared/dashboard/hostStatsAction";

/**
 * Client profiles panel — server-driven search + pagination over the salon's
 * full directory (bookings ∪ imported contacts, de-duped by phone).
 *
 * Owner+senior+admin+receptionist can view; only owner can flip the VIP
 * toggle (server action enforces). Cards are bucketed into lifecycle segments
 * (VIP / new / regular / at-risk) for the visible page — segment counts
 * therefore reflect the current page, not the full directory.
 */

export interface ClientProfilesPanelProps {
  slug: string;
  viewerRole: SalonMemberRole;
  /** Per-salon lifecycle thresholds (Admin Settings). Defaults reproduce the
   *  previous hardcoded behaviour (new ≤ 1 visit, at-risk after 60 days). */
  newMaxVisits?: number;
  atRiskDays?: number;
}

const DEFAULT_PAGE_SIZE = 25;

type Segment = "vip" | "new" | "regular" | "atRisk";
type SegmentFilter = "all" | Segment;

/** View mode for the client list. Persisted in localStorage. */
type ViewMode = "cards" | "list" | "details";

const VIEW_MODE_STORAGE_KEY = "nailiq-clients-view-mode";
const VIEW_MODE_VALUES: ViewMode[] = ["cards", "list", "details"];

function isViewMode(v: string | null): v is ViewMode {
  return VIEW_MODE_VALUES.includes(v as ViewMode);
}

/**
 * Assign each client to exactly ONE lifecycle bucket so the chip counts
 * sum to the total. Priority: VIP > new > at-risk > regular.
 */
function clientSegment(
  row: ClientProfileRow,
  nowMs: number,
  newMaxVisits: number,
  atRiskDays: number,
): Segment {
  if (row.isVip) return "vip";
  if (row.visitCount <= newMaxVisits) return "new";
  const lastMs = row.lastVisitAt ? Date.parse(row.lastVisitAt) : NaN;
  const daysSince = Number.isFinite(lastMs)
    ? (nowMs - lastMs) / 86_400_000
    : Infinity;
  if (daysSince > atRiskDays) return "atRisk";
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
  // VI: DD/M/YYYY (no zero-padding). EN: locale-default (M/D/YYYY).
  if (language === "vi") {
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  }
  return d.toLocaleDateString("en-US");
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

// ---------------------------------------------------------------------------
// ClientDetailBody — shared expanded content across all three view modes
// ---------------------------------------------------------------------------

function ClientDetailBody({
  row,
  segment,
  slug,
  messages,
  language,
  canEditVip,
  onVipChanged,
}: {
  row: ClientProfileRow;
  segment: Segment;
  slug: string;
  messages: ReceptionistMessages["clientProfiles"];
  language: UserLanguage;
  canEditVip: boolean;
  onVipChanged: (next: boolean) => void;
}) {
  const [vipPending, startVipTransition] = useTransition();
  const [vipError, setVipError] = useState<string | null>(null);
  const [host, setHost] = useState<HostStats | null>(null);
  const isVip = segment === "vip";

  useEffect(() => {
    let cancelled = false;
    void getHostStats(slug, row.phone).then((res) => {
      if (!cancelled && res.ok) setHost(res.stats);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, row.phone]);

  return (
    <div
      data-testid={`client-detail-${row.phone}`}
      className="space-y-2 text-sm"
    >
      <p>
        <span className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
          {messages.totalSpent}
        </span>{" "}
        <span className="font-medium text-nq-foreground">
          {formatDollars(row.totalSpentCents)}
        </span>
      </p>

      {/* "Người dẫn nhóm" — celebrate guests brought without inflating
          visit count. Shown only when they've actually organized groups. */}
      {host && host.guestsBrought > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-nq-primary/5 px-2.5 py-2">
          <span className="rounded-full bg-nq-primary/15 px-2 py-0.5 text-xs font-semibold text-nq-primary">
            🎀 {language === "vi" ? "Người dẫn nhóm" : "Group host"}
          </span>
          <span className="text-xs text-nq-muted">
            {language === "vi"
              ? `đã dẫn ${host.guestsBrought} khách qua ${host.groupsOrganized} lần nhóm`
              : `brought ${host.guestsBrought} guest${host.guestsBrought === 1 ? "" : "s"} across ${host.groupsOrganized} group booking${host.groupsOrganized === 1 ? "" : "s"}`}
          </span>
          {canEditVip && !isVip && host.guestsBrought >= 3 ? (
            <span className="text-[11px] font-medium text-amber-500">
              {language === "vi" ? "· nên cân nhắc VIP" : "· consider VIP"}
            </span>
          ) : null}
        </div>
      ) : null}

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
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ClientProfilesPanel({
  slug,
  viewerRole,
  newMaxVisits = CLIENT_SEGMENT_DEFAULTS.newMaxVisits,
  atRiskDays = CLIENT_SEGMENT_DEFAULTS.atRiskDays,
}: ClientProfilesPanelProps) {
  const { language } = useUserLanguage();
  const messages = useMemo(
    () => getUserMessages(language).receptionist.clientProfiles,
    [language],
  );

  // Server-driven data state.
  const [state, setState] = useState<
    | { kind: "loading" }
    | {
        kind: "ok";
        clients: ClientProfileRow[];
        total: number;
        page: number;
        pageSize: number;
      }
    | {
        kind: "error";
        error: Extract<LoadClientProfilesResult, { ok: false }>["error"];
      }
  >({ kind: "loading" });

  // Search + pagination controls.
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = DEFAULT_PAGE_SIZE;

  // Debounce timer ref.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Segment filter (client-side within the current page).
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  // Customer 360 drawer — stores the phone of the currently-open profile.
  const [open360, setOpen360] = useState<string | null>(null);

  // View mode — default "cards"; hydrated from localStorage after mount.
  const [viewMode, setViewModeState] = useState<ViewMode>("cards");

  useEffect(() => {
    // Hydrate stored preference after mount (SSR-safe).
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (isViewMode(stored)) setViewModeState(stored);
    } catch {
      /* ignore quota / private mode */
    }
  }, []);

  const setViewMode = useCallback((next: ViewMode) => {
    setViewModeState(next);
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
    } catch {
      /* ignore quota / private mode */
    }
  }, []);

  // isPending tracks in-flight server requests for subtle loading overlay.
  const [isPending, startTransition] = useTransition();

  // ── Fetch helper ──────────────────────────────────────────────────────────
  const fetchPage = useCallback(
    (q: string, p: number) => {
      startTransition(async () => {
        const res = await loadClientProfiles(slug, {
          search: q,
          page: p,
          pageSize,
        });
        if (res.ok) {
          setState({
            kind: "ok",
            clients: res.clients,
            total: res.total,
            page: res.page,
            pageSize: res.pageSize,
          });
        } else {
          setState({ kind: "error", error: res.error });
        }
      });
    },
    [slug, pageSize],
  );

  // Initial load.
  useEffect(() => {
    fetchPage("", 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // ── Search with 300ms debounce ────────────────────────────────────────────
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
      setSegment("all");
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setPage(1);
        fetchPage(value, 1);
      }, 300);
    },
    [fetchPage],
  );

  // ── Pagination ────────────────────────────────────────────────────────────
  const totalPages =
    state.kind === "ok"
      ? Math.max(1, Math.ceil(state.total / state.pageSize))
      : 1;

  const handlePrev = useCallback(() => {
    if (page <= 1) return;
    const next = page - 1;
    setPage(next);
    fetchPage(search, next);
  }, [page, search, fetchPage]);

  const handleNext = useCallback(() => {
    if (page >= totalPages) return;
    const next = page + 1;
    setPage(next);
    fetchPage(search, next);
  }, [page, totalPages, search, fetchPage]);

  // ── Segment filter (client-side within the fetched page) ──────────────────
  const clients = state.kind === "ok" ? state.clients : null;

  const segmentOf = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity -- render-time "now" snapshot for relative at-risk day math; recomputed when clients/thresholds change
    const nowMs = Date.now();
    const map = new Map<string, Segment>();
    for (const r of clients ?? [])
      map.set(r.phone, clientSegment(r, nowMs, newMaxVisits, atRiskDays));
    return map;
  }, [clients, newMaxVisits, atRiskDays]);

  const segmentCounts = useMemo(() => {
    const c: Record<SegmentFilter, number> = {
      all: clients?.length ?? 0,
      vip: 0,
      new: 0,
      regular: 0,
      atRisk: 0,
    };
    for (const seg of segmentOf.values()) c[seg] += 1;
    return c;
  }, [clients, segmentOf]);

  const filtered = useMemo(() => {
    if (!clients) return [];
    if (segment === "all") return clients;
    return clients.filter((r) => segmentOf.get(r.phone) === segment);
  }, [clients, segment, segmentOf]);

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

  const totalCount = state.kind === "ok" ? state.total : 0;

  // Shared VIP-changed updater (used by all three views).
  const handleVipChanged = useCallback(
    (phone: string, next: boolean) => {
      setState((prev) => {
        if (prev.kind !== "ok") return prev;
        return {
          ...prev,
          clients: prev.clients.map((r) =>
            r.phone === phone ? { ...r, isVip: next } : r,
          ),
        };
      });
    },
    [],
  );

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-nq-foreground">
            {messages.pageTitle}
          </h1>
          <p className="mt-1 text-sm text-nq-muted">{messages.sectionIntro}</p>
        </div>
        <div className="flex items-center gap-3">
          {state.kind === "ok" ? (
            <span className="text-sm text-nq-muted" aria-live="polite">
              {messages.totalCountLabel(totalCount)}
            </span>
          ) : null}

          {/* ── View-mode toggle ── */}
          <div
            className="flex items-center rounded-xl border border-nq-border/60 bg-nq-surface/50 p-0.5"
            role="group"
            aria-label="View mode"
          >
            <ViewModeButton
              mode="cards"
              current={viewMode}
              label={messages.viewModes.cards}
              icon={<LayoutGrid className="h-4 w-4" />}
              testId="client-view-cards"
              onClick={setViewMode}
            />
            <ViewModeButton
              mode="list"
              current={viewMode}
              label={messages.viewModes.list}
              icon={<List className="h-4 w-4" />}
              testId="client-view-list"
              onClick={setViewMode}
            />
            <ViewModeButton
              mode="details"
              current={viewMode}
              label={messages.viewModes.details}
              icon={<Table2 className="h-4 w-4" />}
              testId="client-view-details"
              onClick={setViewMode}
            />
          </div>
        </div>
      </header>

      {/* ── Search input ── */}
      <div className="space-y-3">
        <label htmlFor="client-profiles-search" className="sr-only">
          {messages.searchPlaceholder}
        </label>
        <input
          id="client-profiles-search"
          type="search"
          data-testid="client-profiles-search"
          placeholder={messages.searchPlaceholder}
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          aria-label={messages.searchPlaceholder}
          className={cn(
            "h-11 w-full rounded-xl border border-nq-border bg-nq-surface/60 px-4 text-sm text-nq-foreground placeholder:text-nq-muted",
            "transition-shadow focus:outline-none focus:ring-2 focus:ring-nq-primary/35",
          )}
        />

        {/* Segment chips — client-side filter within the loaded page */}
        {state.kind === "ok" && (clients?.length ?? 0) > 0 ? (
          <div
            className="flex flex-wrap gap-2"
            role="tablist"
            aria-label="Filter clients by segment"
          >
            {segmentChips.map((chip) => {
              const active = segment === chip.key;
              const n = segmentCounts[chip.key];
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

      {/* ── Loading state (initial or transition) ── */}
      {state.kind === "loading" ? (
        <SkeletonCardGrid count={6} cardClassName="h-[112px]" />
      ) : null}

      {/* Subtle loading overlay during pagination / search transitions */}
      {isPending && state.kind === "ok" ? (
        <div
          aria-live="polite"
          aria-label={messages.loading}
          className="flex justify-center py-4"
        >
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-nq-border border-t-nq-primary" />
        </div>
      ) : null}

      {/* ── Error state ── */}
      {state.kind === "error" ? (
        <p
          role="alert"
          data-testid="client-profiles-error"
          className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
        >
          {errorCopy}
        </p>
      ) : null}

      {/* ── Empty state ── */}
      {state.kind === "ok" && !isPending && filtered.length === 0 ? (
        <EmptyState title={messages.empty} />
      ) : null}

      {/* ── Client list (view-mode aware) ── */}
      {state.kind === "ok" && filtered.length > 0 ? (
        <>
          {viewMode === "cards" ? (
            <ul
              data-testid="client-profiles-list"
              className={cn(
                "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3",
                isPending && "opacity-60 transition-opacity",
              )}
            >
              {filtered.map((row) => (
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
                  onVipChanged={(next) => handleVipChanged(row.phone, next)}
                  onOpen360={() => setOpen360(row.phone)}
                />
              ))}
            </ul>
          ) : viewMode === "list" ? (
            <ul
              data-testid="client-profiles-list"
              className={cn(
                "flex flex-col divide-y divide-nq-border/40 rounded-2xl border border-nq-border/50 bg-nq-surface/30",
                isPending && "opacity-60 transition-opacity",
              )}
            >
              {filtered.map((row) => (
                <ClientListRow
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
                  onVipChanged={(next) => handleVipChanged(row.phone, next)}
                  onOpen360={() => setOpen360(row.phone)}
                />
              ))}
            </ul>
          ) : (
            /* details */
            <div
              data-testid="client-profiles-list"
              className={cn(
                "overflow-x-auto rounded-2xl border border-nq-border/50 bg-nq-surface/30",
                isPending && "opacity-60 transition-opacity",
              )}
            >
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-nq-border/40 bg-nq-surface/60">
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-nq-muted">
                      {messages.tableColumns.name}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-nq-muted">
                      {messages.tableColumns.phone}
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-nq-muted">
                      {messages.tableColumns.visits}
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-nq-muted">
                      {messages.tableColumns.lastVisit}
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-nq-muted">
                      {messages.tableColumns.spent}
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wide text-nq-muted">
                      {messages.tableColumns.vip}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-nq-border/30">
                  {filtered.map((row) => (
                    <ClientDetailsRow
                      key={row.id}
                      row={row}
                      segment={segmentOf.get(row.phone) ?? "regular"}
                      isOpen={expanded === row.phone}
                      onToggleOpen={() =>
                        setExpanded((cur) =>
                          cur === row.phone ? null : row.phone,
                        )
                      }
                      canEditVip={viewerRole === "owner"}
                      slug={slug}
                      messages={messages}
                      language={language}
                      onVipChanged={(next) => handleVipChanged(row.phone, next)}
                      onOpen360={() => setOpen360(row.phone)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}

      {/* ── Customer 360 drawer ── */}
      <ClientProfile360Drawer
        slug={slug}
        clientPhone={open360}
        viewerRole={viewerRole}
        onClose={() => setOpen360(null)}
      />

      {/* ── Pagination controls ── */}
      {state.kind === "ok" && totalCount > pageSize ? (
        <div
          className="flex items-center justify-between gap-4 border-t border-nq-border/40 pt-4"
          aria-label="Pagination"
        >
          <button
            type="button"
            onClick={handlePrev}
            disabled={page <= 1 || isPending}
            aria-label={messages.prevPage}
            className={cn(
              "rounded-full border border-nq-border bg-nq-surface/60 px-5 py-2 text-sm font-medium",
              "transition-colors hover:border-nq-primary/40 hover:text-nq-primary",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            {messages.prevPage}
          </button>

          <span
            className="text-sm tabular-nums text-nq-muted"
            aria-live="polite"
          >
            {messages.pageLabel(page, totalPages)}
          </span>

          <button
            type="button"
            onClick={handleNext}
            disabled={page >= totalPages || isPending}
            aria-label={messages.nextPage}
            className={cn(
              "rounded-full border border-nq-border bg-nq-surface/60 px-5 py-2 text-sm font-medium",
              "transition-colors hover:border-nq-primary/40 hover:text-nq-primary",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            {messages.nextPage}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ViewModeButton helper
// ---------------------------------------------------------------------------

function ViewModeButton({
  mode,
  current,
  label,
  icon,
  testId,
  onClick,
}: {
  mode: ViewMode;
  current: ViewMode;
  label: string;
  icon: React.ReactNode;
  testId: string;
  onClick: (mode: ViewMode) => void;
}) {
  const active = mode === current;
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={() => onClick(mode)}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-[var(--duration-nq-fast)]",
        active
          ? "bg-nq-primary/15 text-nq-primary shadow-sm"
          : "text-nq-muted hover:bg-nq-bg/60 hover:text-nq-foreground",
      )}
    >
      {icon}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ClientCard (cards view — unchanged from original)
// ---------------------------------------------------------------------------

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
  onOpen360,
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
  onOpen360?: () => void;
}) {
  const phoneDisplay = formatPhone(row.phone) ?? row.phone;
  const isVip = segment === "vip";
  const badgeLabel = messages.segments[segment];

  // Gracefully handle import-only clients with no visits yet.
  const lastVisitDisplay =
    row.visitCount === 0 || !row.lastVisitAt
      ? messages.noVisitsYet
      : formatLastVisit(row.lastVisitAt, language);

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
              {onOpen360 ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onOpen360(); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onOpen360(); } }}
                  className="cursor-pointer truncate text-sm font-semibold text-nq-foreground underline-offset-2 hover:text-nq-primary hover:underline focus-visible:outline-none focus-visible:underline"
                >
                  {row.name?.trim() || messages.unknownName}
                </span>
              ) : (
                <span className="truncate text-sm font-semibold text-nq-foreground">
                  {row.name?.trim() || messages.unknownName}
                </span>
              )}
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
          <Stat label={messages.statLastVisit} value={lastVisitDisplay} />
        </dl>
      </button>

      {isOpen ? (
        <div className="border-t border-nq-border/40 px-4 py-3">
          <ClientDetailBody
            row={row}
            segment={segment}
            slug={slug}
            messages={messages}
            language={language}
            canEditVip={canEditVip}
            onVipChanged={onVipChanged}
          />
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// ClientListRow (list view — compact horizontal row)
// ---------------------------------------------------------------------------

function ClientListRow({
  row,
  segment,
  isOpen,
  onToggleOpen,
  canEditVip,
  slug,
  messages,
  language,
  onVipChanged,
  onOpen360,
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
  onOpen360?: () => void;
}) {
  const phoneDisplay = formatPhone(row.phone) ?? row.phone;
  const isVip = segment === "vip";

  const lastVisitDisplay =
    row.visitCount === 0 || !row.lastVisitAt
      ? messages.noVisitsYet
      : formatLastVisit(row.lastVisitAt, language);

  return (
    <li data-testid={`client-row-${row.phone}`}>
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left",
          "transition-colors hover:bg-nq-bg/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nq-primary/40",
          isOpen && "bg-nq-bg/30",
        )}
      >
        {/* Avatar */}
        <span
          aria-hidden
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
            isVip
              ? "bg-nq-primary/15 text-nq-primary ring-1 ring-nq-primary/50"
              : "bg-nq-bg/70 text-nq-foreground ring-1 ring-nq-border/60",
          )}
        >
          {initialsOf(row.name)}
        </span>

        {/* Name + phone */}
        <div className="min-w-0 flex-1">
          {onOpen360 ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onOpen360(); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onOpen360(); } }}
              className="block cursor-pointer truncate text-sm font-semibold text-nq-foreground underline-offset-2 hover:text-nq-primary hover:underline focus-visible:outline-none focus-visible:underline"
            >
              {row.name?.trim() || messages.unknownName}
            </span>
          ) : (
            <span className="block truncate text-sm font-semibold text-nq-foreground">
              {row.name?.trim() || messages.unknownName}
            </span>
          )}
          <span className="block truncate font-mono text-[11px] tabular-nums text-nq-muted">
            {phoneDisplay}
          </span>
        </div>

        {/* VIP star + segment badge */}
        <div className="flex shrink-0 items-center gap-2">
          {isVip ? (
            <span aria-label="VIP" className="text-sm leading-none text-nq-primary">
              ⭐
            </span>
          ) : null}
          <Badge variant={SEGMENT_BADGE[segment]} state="default" size="sm">
            {messages.segments[segment]}
          </Badge>
        </div>

        {/* Visit count + last visit */}
        <div className="hidden shrink-0 text-right sm:block">
          <span className="block text-sm font-semibold tabular-nums text-nq-foreground">
            {row.visitCount}
          </span>
          <span className="block text-[11px] text-nq-muted">{lastVisitDisplay}</span>
        </div>
      </button>

      {isOpen ? (
        <div className="border-t border-nq-border/30 bg-nq-bg/20 px-4 py-3">
          <ClientDetailBody
            row={row}
            segment={segment}
            slug={slug}
            messages={messages}
            language={language}
            canEditVip={canEditVip}
            onVipChanged={onVipChanged}
          />
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// ClientDetailsRow (details / table view)
// ---------------------------------------------------------------------------

function ClientDetailsRow({
  row,
  segment,
  isOpen,
  onToggleOpen,
  canEditVip,
  slug,
  messages,
  language,
  onVipChanged,
  onOpen360,
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
  onOpen360?: () => void;
}) {
  const phoneDisplay = formatPhone(row.phone) ?? row.phone;
  const isVip = segment === "vip";

  const lastVisitDisplay =
    row.visitCount === 0 || !row.lastVisitAt
      ? "—"
      : formatLastVisit(row.lastVisitAt, language);

  return (
    <>
      <tr
        data-testid={`client-row-${row.phone}`}
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        className={cn(
          "cursor-pointer transition-colors",
          isOpen
            ? "bg-nq-primary/5"
            : "hover:bg-nq-bg/40",
        )}
      >
        {/* Name */}
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                isVip
                  ? "bg-nq-primary/15 text-nq-primary ring-1 ring-nq-primary/50"
                  : "bg-nq-bg/70 text-nq-foreground ring-1 ring-nq-border/60",
              )}
            >
              {initialsOf(row.name)}
            </span>
            {onOpen360 ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onOpen360(); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onOpen360(); } }}
                className="cursor-pointer truncate text-sm font-semibold text-nq-foreground underline-offset-2 hover:text-nq-primary hover:underline focus-visible:outline-none focus-visible:underline"
              >
                {row.name?.trim() || messages.unknownName}
              </span>
            ) : (
              <span className="truncate text-sm font-semibold text-nq-foreground">
                {row.name?.trim() || messages.unknownName}
              </span>
            )}
          </div>
        </td>

        {/* Phone */}
        <td className="px-4 py-3 font-mono text-xs tabular-nums text-nq-muted">
          {phoneDisplay}
        </td>

        {/* Visits */}
        <td className="px-4 py-3 text-right tabular-nums text-sm text-nq-foreground">
          {row.visitCount}
        </td>

        {/* Last visit */}
        <td className="px-4 py-3 text-right text-sm tabular-nums text-nq-muted">
          {lastVisitDisplay}
        </td>

        {/* Spent */}
        <td className="px-4 py-3 text-right tabular-nums text-sm text-nq-foreground">
          {formatDollarsCompact(row.totalSpentCents)}
        </td>

        {/* VIP */}
        <td className="px-4 py-3 text-center">
          {isVip ? (
            <span aria-label="VIP" className="text-sm text-nq-primary">
              ⭐
            </span>
          ) : (
            <span className="text-nq-border/40">—</span>
          )}
        </td>
      </tr>

      {isOpen ? (
        <tr>
          <td
            colSpan={6}
            className="border-t border-nq-border/30 bg-nq-bg/20 px-6 py-4"
          >
            <ClientDetailBody
              row={row}
              segment={segment}
              slug={slug}
              messages={messages}
              language={language}
              canEditVip={canEditVip}
              onVipChanged={onVipChanged}
            />
          </td>
        </tr>
      ) : null}
    </>
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
