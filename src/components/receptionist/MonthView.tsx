"use client";

import { useEffect, useMemo, useState } from "react";

import { Card } from "@/components/ui/Card";
import { loadReceptionistCenterDataAction } from "@/shared/dashboard/loadReceptionistCenterDataAction";
import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import type { ReceptionistMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { formatInSalonTz } from "@/shared/lib/salonTime";

/**
 * Read-only month-calendar grid for the Receptionist Center.
 *
 * Layout: standard Mon–Sun 7-column calendar (6-week rows max).
 * Greyed-out cells from prev/next month are shown for context but
 * carry no bookings. Each in-month day shows up to 3 booking chips;
 * "+N more" overflow indicator when there are more.
 *
 * Clicking a booking chip → `onBookingClick(bookingId, ymd)` so the
 * parent can load that day and open the BookingDetailDrawer.
 * Clicking a day number → `onDayClick(ymd)` to flip back to Day view.
 */

const TOP_BOOKINGS_PER_DAY = 3;
const DAY_FETCH_TIMEOUT_MS = 20_000;

// ─── Date helpers ────────────────────────────────────────────────────────────

function ymdToLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function localDateToYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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

// ─── Types ───────────────────────────────────────────────────────────────────

type DayState =
  | { kind: "loading" }
  | { kind: "ok"; bookings: ReceptionistCenterData["bookingsForDay"] }
  | { kind: "error" };

export interface MonthViewProps {
  slug: string;
  /** YYYY-MM-01 — first day of the visible month. */
  firstYmd: string;
  /** Salon timezone — used for booking time labels. */
  timezone: string;
  /** Today (salon-local) for highlighting. */
  todayYmd: string;
  messages: ReceptionistMessages["monthView"];
  /** Tap a day number → switch to Day view. */
  onDayClick: (ymd: string) => void;
  /** Tap a booking chip → open detail drawer. */
  onBookingClick: (bookingId: string, ymd: string) => void;
  /** Month navigation. */
  onPrevMonth: () => void;
  onThisMonth: () => void;
  onNextMonth: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

/** Weekday header labels Mon–Sun (short). */
const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function MonthView({
  slug,
  firstYmd,
  timezone,
  todayYmd,
  messages,
  onDayClick,
  onBookingClick,
  onPrevMonth,
  onThisMonth,
  onNextMonth,
}: MonthViewProps) {
  const cells = useMemo(() => buildMonthGrid(firstYmd), [firstYmd]);

  // Only fetch in-month days.
  const inMonthYmds = useMemo(
    () => cells.filter((c) => c.inMonth).map((c) => c.ymd),
    [cells],
  );

  const [days, setDays] = useState<Record<string, DayState>>({});

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- optimistic loading state before async fetch
    setDays(
      Object.fromEntries(
        inMonthYmds.map((y) => [y, { kind: "loading" } as DayState]),
      ),
    );

    const withTimeout = <T,>(p: Promise<T>): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), DAY_FETCH_TIMEOUT_MS),
        ),
      ]);

    void Promise.allSettled(
      inMonthYmds.map(async (ymd) => {
        const res = await withTimeout(loadReceptionistCenterDataAction(slug, ymd));
        return { ymd, res };
      }),
    ).then((settled) => {
      if (cancelled) return;
      const next: Record<string, DayState> = {};
      for (const result of settled) {
        if (result.status === "fulfilled") {
          const { ymd, res } = result.value;
          next[ymd] = res.ok
            ? { kind: "ok", bookings: res.data.bookingsForDay }
            : { kind: "error" };
        } else {
          for (const ymd of inMonthYmds) {
            if (!(ymd in next)) next[ymd] = { kind: "error" };
          }
        }
      }
      setDays(next);
    }).catch(() => {
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
  }, [slug, inMonthYmds]);

  const monthLabel = useMemo(() => {
    const d = ymdToLocalDate(firstYmd);
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
    }).format(d);
  }, [firstYmd]);

  return (
    <div
      data-testid="month-view"
      className="mx-auto flex w-full flex-col gap-3 px-[var(--pad-nq-section-mobile)] py-4 md:px-6"
    >
      {/* Navigation header */}
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

      {/* Weekday column headers */}
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAY_HEADERS.map((h) => (
          <div
            key={h}
            className="text-[10px] font-semibold uppercase tracking-wide text-nq-muted"
          >
            {h}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map(({ ymd, inMonth }) => {
          const isToday = ymd === todayYmd;
          const state = inMonth ? (days[ymd] ?? { kind: "loading" as const }) : null;
          const dayNum = ymdToLocalDate(ymd).getDate();

          return (
            <Card
              key={ymd}
              variant={isToday ? "elevated" : "default"}
              padding="none"
              className={cn(
                "min-h-[6rem] overflow-hidden",
                !inMonth && "opacity-30",
                isToday && "ring-1 ring-nq-primary/45",
              )}
            >
              {/* Day number — clickable if in-month */}
              <div className="flex items-center justify-between border-b border-nq-border/30 px-1.5 py-1">
                {inMonth ? (
                  <button
                    type="button"
                    onClick={() => onDayClick(ymd)}
                    className={cn(
                      "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-semibold tabular-nums transition-colors",
                      isToday
                        ? "bg-nq-primary text-nq-bg"
                        : "text-nq-foreground hover:bg-nq-primary/15 hover:text-nq-primary",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
                    )}
                    aria-label={`Open day view for ${ymd}`}
                  >
                    {dayNum}
                  </button>
                ) : (
                  <span className="px-1 text-xs font-semibold tabular-nums text-nq-muted">
                    {dayNum}
                  </span>
                )}
              </div>

              {/* Booking content */}
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
                    onBookingClick={(id) => onBookingClick(id, ymd)}
                  />
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ─── MonthDayBookings ─────────────────────────────────────────────────────────

function MonthDayBookings({
  bookings,
  timezone,
  moreLabel,
  openBookingAria,
  onBookingClick,
}: {
  bookings: ReceptionistCenterData["bookingsForDay"];
  timezone: string;
  moreLabel: string;
  openBookingAria: string;
  onBookingClick: (bookingId: string) => void;
}) {
  const sorted = useMemo(() => {
    return [...bookings]
      .filter(
        (b) =>
          b.status === "pending" ||
          b.status === "confirmed" ||
          b.status === "in_progress" ||
          b.status === "completed",
      )
      .sort((a, b) => {
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
          aria-label={openBookingAria.replace("{client}", b.client_name)}
          onClick={() => onBookingClick(b.id)}
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
          <span className="truncate">{b.client_name}</span>
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
