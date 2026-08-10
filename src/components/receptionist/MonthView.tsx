"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import {
  getBookingsForRangeAction,
  type BookingsRangeHint,
  type CalendarBooking,
} from "@/shared/dashboard/getBookingsForRangeAction";
import type { ReceptionistMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import { ymdToLocalDate, localDateToYmd } from "@/shared/lib/localDateYmd";

/**
 * Read-only month-calendar grid for the Receptionist Center.
 *
 * UX — two-level drill-down (no view switch required):
 *   1. Click a day cell → calendar grid compresses; day-detail panel slides in
 *      from the right (Framer Motion spring). Panel lists all bookings for
 *      that day with time, client, service, and status.
 *   2. Click a booking in the panel → `onBookingClick` opens the drawer.
 *   3. "Full day view" button in the panel → `onDayClick` switches to Day view.
 *
 * Data: single `getBookingsForRangeAction` call per month (fast-path when
 * `hint` is provided — membership check + bookings query run in parallel).
 */

const TOP_BOOKINGS_PER_DAY = 3;
const RANGE_FETCH_TIMEOUT_MS = 20_000;

// ─── Date helpers (device-local YMD↔Date) live in @/shared/lib/localDateYmd ──

/** First day of the month (YYYY-MM-01) for any YMD in that month. */
export function firstOfMonth(ymd: string): string {
  const d = ymdToLocalDate(ymd);
  d.setDate(1);
  return localDateToYmd(d);
}

/** Shift the month anchor forward/back by `months`. */
export function shiftMonth(firstYmd: string, months: number): string {
  const d = ymdToLocalDate(firstYmd);
  d.setMonth(d.getMonth() + months);
  d.setDate(1);
  return localDateToYmd(d);
}

/**
 * Build the full calendar grid cells for a Mon–Sun layout.
 * Returns an array of `{ ymd, inMonth }` — cells from prev/next month
 * are included with `inMonth: false` to fill the grid rows.
 */
function buildMonthGrid(firstYmd: string): Array<{ ymd: string; inMonth: boolean }> {
  const start = ymdToLocalDate(firstYmd);
  const year = start.getFullYear();
  const month = start.getMonth();

  // Monday of the week containing the 1st of the month.
  const monOffset = (start.getDay() + 6) % 7; // Sun=0 → Mon=0 offset
  const gridStart = new Date(start);
  gridStart.setDate(1 - monOffset);

  // Last day of the month.
  const lastDay = new Date(year, month + 1, 0).getDate();

  // We need at least enough rows to cover all days.
  const totalDays = monOffset + lastDay;
  const rows = Math.ceil(totalDays / 7);
  const cells: Array<{ ymd: string; inMonth: boolean }> = [];

  for (let i = 0; i < rows * 7; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const ymd = localDateToYmd(d);
    const inMonth = d.getMonth() === month && d.getFullYear() === year;
    cells.push({ ymd, inMonth });
  }

  return cells;
}

/** Long date label for the panel header, localized (e.g. "Thứ Ba, 27 tháng 5"). */
function formatDayLabel(ymd: string, language: "en" | "vi"): string {
  const d = ymdToLocalDate(ymd);
  return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
}

// ─── Types ───────────────────────────────────────────────────────────────────

type DayState =
  | { kind: "loading" }
  | { kind: "ok"; bookings: CalendarBooking[] }
  | { kind: "error" };

export interface MonthViewProps {
  slug: string;
  /** YYYY-MM-01 — first day of the visible month. */
  firstYmd: string;
  /** Salon timezone — used for booking time labels. */
  timezone: string;
  /** Today (salon-local) for highlighting. */
  todayYmd: string;
  /** UI language for the localized day-panel date label. */
  language: "en" | "vi";
  messages: ReceptionistMessages["monthView"];
  /** Localized label for a redacted/removed customer ("[removed]" in DB). */
  removedGuest: string;
  /** Tap a day number → switch to Day view. */
  onDayClick: (ymd: string) => void;
  /** Tap a booking chip → open detail drawer. */
  onBookingClick: (bookingId: string, ymd: string) => void;
  /** Month navigation. */
  onPrevMonth: () => void;
  onThisMonth: () => void;
  onNextMonth: () => void;
  /** Shell V2 owns period navigation in the desk header. */
  showNavigation?: boolean;
  /**
   * Pre-resolved context from the SSR parent — enables the fast-path in
   * `getBookingsForRangeAction` that skips the 3-call auth chain and instead
   * runs membership-check + bookings-query in parallel. Without this, every
   * prev/next-month click makes 4 sequential Supabase round-trips (~250ms);
   * with it, only 2 (~120ms).
   */
  hint?: BookingsRangeHint;
  /**
   * Bumped by the parent on any booking mutation. Included in the fetch deps
   * so a cancel/reschedule done from this view's drawer refetches fresh data
   * instead of leaving a stale booking in this view's local cache. (QA #5.)
   */
  refreshNonce?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Weekday header labels Mon–Sun (short). */
/** Localized short weekday names, Mon→Sun (2024-01-01 is a Monday). */
function localizedWeekdays(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(2024, 0, 1 + i)),
  );
}

const PANEL_SPRING = { type: "spring", damping: 26, stiffness: 300 } as const;
const LAYOUT_SPRING = { type: "spring", damping: 30, stiffness: 280 } as const;

// ─── Component ───────────────────────────────────────────────────────────────

export function MonthView({
  slug,
  firstYmd,
  timezone,
  todayYmd,
  language,
  messages,
  removedGuest,
  onDayClick,
  onBookingClick,
  onPrevMonth,
  onThisMonth,
  onNextMonth,
  showNavigation = true,
  hint,
  refreshNonce,
}: MonthViewProps) {
  const cells = useMemo(() => buildMonthGrid(firstYmd), [firstYmd]);

  // In-month YMDs for the loading state initialisation and fallback error mapping.
  const inMonthYmds = useMemo(
    () => cells.filter((c) => c.inMonth).map((c) => c.ymd),
    [cells],
  );

  // Last day of the month — used as the inclusive end of the range query.
  const lastYmd = useMemo(() => {
    const d = ymdToLocalDate(firstYmd);
    d.setMonth(d.getMonth() + 1, 0); // day 0 of next month = last day of this month
    return localDateToYmd(d);
  }, [firstYmd]);

  const [days, setDays] = useState<Record<string, DayState>>({});

  // Currently selected day for the detail panel. Cleared when month changes.
  const [selectedYmd, setSelectedYmd] = useState<string | null>(null);

  // Close panel when navigating to a different month.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset panel on month change
    setSelectedYmd(null);
  }, [firstYmd]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- optimistic loading state before async fetch
    setDays(
      Object.fromEntries(
        inMonthYmds.map((y) => [y, { kind: "loading" } as DayState]),
      ),
    );

    // Single range call — 1 round-trip for all ~28-31 days of the month.
    const withTimeout = <T,>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), RANGE_FETCH_TIMEOUT_MS),
        ),
      ]);

    void withTimeout(getBookingsForRangeAction(slug, firstYmd, lastYmd, hint))
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setDays(
            Object.fromEntries(
              inMonthYmds.map((y) => [y, { kind: "error" } as DayState]),
            ),
          );
          return;
        }
        const next: Record<string, DayState> = {};
        for (const ymd of inMonthYmds) {
          next[ymd] = { kind: "ok", bookings: res.days[ymd] ?? [] };
        }
        setDays(next);
      })
      .catch(() => {
        if (cancelled) return;
        setDays(
          Object.fromEntries(
            inMonthYmds.map((y) => [y, { kind: "error" } as DayState]),
          ),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [slug, firstYmd, lastYmd, inMonthYmds, hint, refreshNonce]);

  const locale = language === "vi" ? "vi-VN" : "en-US";
  const weekdayHeaders = useMemo(() => localizedWeekdays(locale), [locale]);
  const monthLabel = useMemo(() => {
    const d = ymdToLocalDate(firstYmd);
    return new Intl.DateTimeFormat(locale, {
      month: "long",
      year: "numeric",
    }).format(d);
  }, [firstYmd, locale]);

  const panelOpen = selectedYmd !== null;
  const panelState = selectedYmd ? (days[selectedYmd] ?? { kind: "loading" as const }) : null;

  return (
    <div
      data-testid="month-view"
      className="mx-auto flex w-full flex-col gap-3 px-[var(--pad-nq-section-mobile)] py-4 md:px-6"
    >
      {/* ── Navigation header ───────────────────────────────────────────── */}
      {showNavigation ? (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
            {messages.title}
          </p>
          <p className="truncate text-sm font-medium text-nq-foreground">
            {monthLabel}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            data-testid="month-view-prev"
            onClick={onPrevMonth}
            className="rounded-md border border-nq-border bg-nq-surface px-2.5 py-1 text-xs font-medium text-nq-foreground hover:border-nq-primary/40"
          >
            ← {messages.prevMonth}
          </button>
          <button
            type="button"
            data-testid="month-view-this-month"
            onClick={onThisMonth}
            className="rounded-md border border-nq-primary/45 bg-nq-primary/10 px-2.5 py-1 text-xs font-medium text-nq-primary hover:bg-nq-primary/[0.16]"
          >
            {messages.thisMonth}
          </button>
          <button
            type="button"
            data-testid="month-view-next"
            onClick={onNextMonth}
            className="rounded-md border border-nq-border bg-nq-surface px-2.5 py-1 text-xs font-medium text-nq-foreground hover:border-nq-primary/40"
          >
            {messages.nextMonth} →
          </button>
        </div>
      </div>
      ) : null}

      {/* ── Main area: calendar + detail panel ──────────────────────────── */}
      <div className="flex items-start gap-3 overflow-x-hidden">

        {/* Calendar grid — motion.div with layout so it smoothly shrinks
            when the detail panel slides in next to it.                    */}
        <motion.div
          layout
          transition={LAYOUT_SPRING}
          className="min-w-0 flex-1"
        >
          {/* Weekday column headers */}
          <div className="mb-1 grid grid-cols-7 gap-1 text-center">
            {weekdayHeaders.map((h) => (
              <div
                key={h}
                className="text-[10px] font-semibold uppercase tracking-wide text-nq-muted"
              >
                {h}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 gap-1">
            {cells.map(({ ymd, inMonth }) => {
              const isToday = ymd === todayYmd;
              const isSelected = ymd === selectedYmd;
              const state = inMonth ? (days[ymd] ?? { kind: "loading" as const }) : null;
              const dayNum = ymdToLocalDate(ymd).getDate();

              return (
                <Card
                  key={ymd}
                  variant={isToday ? "elevated" : "default"}
                  padding="none"
                  className={cn(
                    "min-h-[5.5rem] overflow-hidden transition-shadow",
                    !inMonth && "pointer-events-none opacity-25",
                    isToday && "ring-1 ring-nq-primary/45",
                    isSelected && "ring-2 ring-nq-primary shadow-md",
                    inMonth && !isSelected && "cursor-pointer hover:ring-1 hover:ring-nq-primary/30",
                  )}
                  // Click anywhere on the day cell → open detail panel
                  onClick={inMonth ? () => {
                    setSelectedYmd((prev) => prev === ymd ? null : ymd);
                  } : undefined}
                  role={inMonth ? "button" : undefined}
                  aria-pressed={isSelected ? true : undefined}
                  aria-label={inMonth ? `View bookings for ${ymd}` : undefined}
                >
                  {/* Day number header */}
                  <div className="flex items-center justify-between border-b border-nq-border/30 px-1.5 py-1">
                    <span
                      className={cn(
                        "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold tabular-nums",
                        isToday
                          ? "bg-nq-primary text-nq-bg"
                          : isSelected
                            ? "bg-nq-primary/20 text-nq-primary"
                            : "text-nq-foreground",
                      )}
                    >
                      {dayNum}
                    </span>
                  </div>

                  {/* Booking chips */}
                  <div className="flex flex-col gap-0.5 p-1">
                    {!inMonth ? null : state?.kind === "loading" ? (
                      <div className="flex justify-center py-2">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-nq-muted/50" />
                      </div>
                    ) : state?.kind === "error" ? (
                      <p className="text-center text-[10px] text-nq-error">
                        {messages.dayError}
                      </p>
                    ) : state?.kind === "ok" ? (
                      <MonthDayBookings
                        bookings={state.bookings}
                        timezone={timezone}
                        moreLabel={messages.moreCount}
                        openBookingAria={messages.openBookingAria}
                        removedGuest={removedGuest}
                        // Stop propagation so clicking a chip doesn't also
                        // toggle the selected-day state.
                        onBookingClick={(id) => {
                          onBookingClick(id, ymd);
                        }}
                      />
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </div>
        </motion.div>

        {/* ── Day detail panel — slides in from right ──────────────────── */}
        <AnimatePresence>
          {panelOpen && selectedYmd && (
            <motion.div
              key="day-detail-panel"
              initial={{ x: "100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0 }}
              transition={PANEL_SPRING}
              className="w-72 shrink-0 md:w-80"
              data-testid="month-view-day-panel"
            >
              <DayDetailPanel
                ymd={selectedYmd}
                timezone={timezone}
                language={language}
                state={panelState ?? { kind: "loading" }}
                messages={messages}
                removedGuest={removedGuest}
                onClose={() => setSelectedYmd(null)}
                onBookingClick={(id) => onBookingClick(id, selectedYmd)}
                onOpenDayView={() => {
                  setSelectedYmd(null);
                  onDayClick(selectedYmd);
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── DayDetailPanel ───────────────────────────────────────────────────────────

function statusVariant(
  status: string,
): "success" | "info" | "warning" | "default" {
  if (status === "in_progress") return "success";
  if (status === "confirmed") return "info";
  if (status === "pending") return "warning";
  return "default";
}

function DayDetailPanel({
  ymd,
  timezone,
  language,
  state,
  messages,
  removedGuest,
  onClose,
  onBookingClick,
  onOpenDayView,
}: {
  ymd: string;
  timezone: string;
  language: "en" | "vi";
  state: DayState;
  messages: ReceptionistMessages["monthView"];
  removedGuest: string;
  onClose: () => void;
  onBookingClick: (bookingId: string) => void;
  onOpenDayView: () => void;
}) {
  const sorted = useMemo(() => {
    if (state.kind !== "ok") return [];
    return [...state.bookings].sort((a, b) => {
      const am = Date.parse(a.start_time_utc);
      const bm = Date.parse(b.start_time_utc);
      return (Number.isFinite(am) ? am : 0) - (Number.isFinite(bm) ? bm : 0);
    });
  }, [state]);

  // Status summary counts
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const b of sorted) {
      c[b.status] = (c[b.status] ?? 0) + 1;
    }
    return c;
  }, [sorted]);

  const dayLabel = formatDayLabel(ymd, language);

  return (
    <Card
      variant="elevated"
      padding="none"
      className="flex h-full flex-col overflow-hidden shadow-lg ring-1 ring-nq-primary/20"
    >
      {/* Panel header */}
      <div className="flex items-start justify-between border-b border-nq-border/40 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
            {sorted.length} {sorted.length === 1 ? "booking" : "bookings"}
          </p>
          <p className="mt-0.5 truncate text-sm font-semibold text-nq-foreground">
            {dayLabel}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={messages.closeDayPanel}
          className="ml-2 mt-0.5 shrink-0 rounded-md p-1 text-nq-muted transition-colors hover:bg-nq-border/40 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Status summary chips */}
      {state.kind === "ok" && Object.keys(counts).length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-nq-border/30 px-4 py-2">
          {Object.entries(counts).map(([status, count]) => (
            <Badge
              key={status}
              variant={statusVariant(status)}
              state="subtle"
              size="sm"
            >
              {count} {messages.statusNames[status] ?? status}
            </Badge>
          ))}
        </div>
      )}

      {/* Booking list */}
      <div className="flex-1 overflow-y-auto">
        {state.kind === "loading" ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-nq-primary/30 border-t-nq-primary" />
          </div>
        ) : state.kind === "error" ? (
          <p className="px-4 py-6 text-center text-sm text-nq-error">
            {messages.dayError}
          </p>
        ) : sorted.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm italic text-nq-muted">
            {messages.panelEmpty}
          </p>
        ) : (
          <ul className="divide-y divide-nq-border/20">
            {sorted.map((b) => (
              <motion.li
                key={b.id}
                whileHover={{ backgroundColor: "var(--color-nq-primary-5, rgba(99,102,241,0.05))" }}
                transition={{ duration: 0.15 }}
              >
                <button
                  type="button"
                  aria-label={messages.openBookingAria.replace("{client}", displayCustomerName(b.client_name, removedGuest))}
                  onClick={() => onBookingClick(b.id)}
                  className="group flex w-full items-start gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nq-primary/40"
                >
                  {/* Time pill */}
                  <div className="shrink-0 rounded-md bg-nq-surface px-2 py-1 text-center ring-1 ring-nq-border/50">
                    <p className="text-[11px] font-semibold tabular-nums leading-none text-nq-foreground">
                      {formatInSalonTz(b.start_time_utc, timezone, "shortTime")}
                    </p>
                  </div>

                  {/* Booking info */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-nq-foreground group-hover:text-nq-primary">
                      {displayCustomerName(b.client_name, removedGuest) || "—"}
                    </p>
                    <p className="truncate text-xs text-nq-muted">
                      {b.service_name || "—"}
                    </p>
                  </div>

                  {/* Status badge */}
                  <Badge
                    variant={statusVariant(b.status)}
                    state="subtle"
                    size="sm"
                    className="shrink-0"
                  >
                    {messages.statusNames[b.status] ?? b.status}
                  </Badge>
                </button>
              </motion.li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer — link to full day view */}
      <div className="border-t border-nq-border/40 px-4 py-3">
        <button
          type="button"
          onClick={onOpenDayView}
          className="w-full rounded-md border border-nq-primary/40 bg-nq-primary/8 px-3 py-2 text-xs font-medium text-nq-primary transition-colors hover:bg-nq-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40"
        >
          {messages.openDayView}
        </button>
      </div>
    </Card>
  );
}

// ─── MonthDayBookings ─────────────────────────────────────────────────────────

function MonthDayBookings({
  bookings,
  timezone,
  moreLabel,
  openBookingAria,
  removedGuest,
  onBookingClick,
}: {
  bookings: CalendarBooking[];
  timezone: string;
  moreLabel: string;
  openBookingAria: string;
  removedGuest: string;
  onBookingClick: (bookingId: string) => void;
}) {
  // Bookings already filtered + sorted by getBookingsForRangeAction;
  // re-sort defensively in case the response arrives out of order.
  const sorted = useMemo(() => {
    return [...bookings].sort((a, b) => {
      const am = Date.parse(a.start_time_utc);
      const bm = Date.parse(b.start_time_utc);
      return (Number.isFinite(am) ? am : 0) - (Number.isFinite(bm) ? bm : 0);
    });
  }, [bookings]);

  const visible = sorted.slice(0, TOP_BOOKINGS_PER_DAY);
  const more = Math.max(0, sorted.length - TOP_BOOKINGS_PER_DAY);

  return (
    <>
      {visible.map((b) => (
        <button
          key={b.id}
          type="button"
          aria-label={openBookingAria.replace("{client}", displayCustomerName(b.client_name, removedGuest))}
          onClick={(e) => {
            // Prevent the day-cell onClick from toggling the panel.
            e.stopPropagation();
            onBookingClick(b.id);
          }}
          className={cn(
            "w-full rounded px-1 py-0.5 text-left text-[10px] leading-tight",
            "truncate transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-nq-primary/40",
            b.status === "in_progress"
              ? "bg-nq-success/15 text-nq-success hover:bg-nq-success/25"
              : b.status === "completed"
                ? "bg-nq-muted/10 text-nq-muted hover:bg-nq-muted/20"
                : b.status === "confirmed"
                  ? "bg-nq-primary/12 text-nq-primary hover:bg-nq-primary/20"
                  : "bg-nq-warning/15 text-nq-warning hover:bg-nq-warning/25",
          )}
        >
          <span className="font-medium tabular-nums">
            {formatInSalonTz(b.start_time_utc, timezone, "shortTime")}
          </span>{" "}
          <span className="truncate">{displayCustomerName(b.client_name, removedGuest)}</span>
        </button>
      ))}

      {more > 0 ? (
        <p className="px-1 text-[10px] font-medium text-nq-muted">
          {moreLabel.replace("{n}", String(more))}
        </p>
      ) : null}
    </>
  );
}
