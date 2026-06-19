"use client";

import { useEffect, useMemo, useState } from "react";
import type { BookingStaffItem } from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { bookingDateYmdFromLocalDate } from "@/shared/booking/bookingConfirmLabels";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";
import { getAvailableTimeSlotsCount } from "@/shared/booking/getAvailableTimeSlots";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { cn } from "@/shared/lib/cn";

/**
 * Month-grid date picker shared between the individual booking flow
 * (`BookingFlowDatePanel`) and the group booking flow's step 3.
 *
 * Extracted in 2026-05-12 because the group flow was still on the
 * native `<input type="date">` — which QA caught accepting corrupt
 * typed-in years like 0513 on Chromium. Reusing the same calendar
 * gives both flows identical UX (month nav, opening-hours gating,
 * holiday markers, slot-availability dots) and removes the corrupt-
 * year vector entirely.
 *
 * Visuals + accessibility match what shipped in PR #110:
 *   - 7-column grid, Mon-first week header
 *   - Past / closed / out-of-window cells render disabled with
 *     `aria-pressed=false`
 *   - Today gets a brand ring; selected day gets a brand fill
 *   - Per-cell slot-availability dot when `salonId + staffId +
 *     serviceTotalMinutes` are all known
 *
 * Stays presentation-only — no Continue / Back buttons, no
 * motion wrappers. Owning panels decide layout + buttons.
 */

const WEEK_HDR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function sameLocalCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function calendarDayAbbrev(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short" });
}
function startOfMonth(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), 1);
  x.setHours(12, 0, 0, 0);
  return x;
}
function addMonthsClamped(d: Date, delta: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  x.setHours(12, 0, 0, 0);
  return x;
}
function monthHeaderLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// Slot-availability tiers drive the per-day dot colour and whether an open day
// is still bookable. Counts come from `getAvailableTimeSlotsCount`.
//   open    (> LIMITED_MAX)  → green  "plenty"
//   limited (1..LIMITED_MAX) → amber  "filling up"
//   full    (0, day is open) → red    not bookable (dead-end prevention)
type AvailTier = "open" | "limited" | "full";
const LIMITED_MAX = 3;
function tierFromCount(n: number): AvailTier {
  if (n <= 0) return "full";
  if (n <= LIMITED_MAX) return "limited";
  return "open";
}
// Hard-coded so the dot reads the same on every salon theme (the brand var is
// reused for "selected" fills and would collide with the green "open" signal).
const TIER_DOT_COLOR: Record<AvailTier, string> = {
  open: "#3a9d5a",
  limited: "#c9a227",
  full: "#c0392b",
};

export function BookingCalendarGrid({
  t,
  salonId,
  openingHoursRaw,
  closedDateYmdSet,
  staff,
  staffId,
  serviceTotalMinutes,
  selectedDate,
  windowDays,
  onSelectDate,
}: {
  t: BookingMessages;
  salonId: string;
  openingHoursRaw: unknown | null;
  closedDateYmdSet: ReadonlySet<string>;
  staff: readonly BookingStaffItem[];
  /** UUID or the "any" sentinel — pass `"any"` when the caller
   *  doesn't bind to a specific staff (e.g. group flow). */
  staffId: string;
  /** Pass 0 to skip the per-cell slot-availability fetch. */
  serviceTotalMinutes: number;
  /** `null` = no date selected yet (group flow's initial state).
   *  Individual flow always passes a real Date. */
  selectedDate: Date | null;
  /** Lead-time window in days from today (inclusive). Individual
   *  flow passes 60; group flow passes 365 so wedding parties can
   *  book months out. */
  windowDays: number;
  onSelectDate: (d: Date) => void;
}) {
  const todayStart = useMemo(() => startOfLocalDay(new Date()), []);
  const windowEnd = useMemo(() => {
    const x = new Date(todayStart);
    x.setDate(todayStart.getDate() + Math.max(1, windowDays) - 1);
    return x;
  }, [todayStart, windowDays]);

  const minMonth = useMemo(() => startOfMonth(todayStart), [todayStart]);
  const maxMonth = useMemo(() => startOfMonth(windowEnd), [windowEnd]);

  // First bookable month within the lead-time window: scan forward from today
  // for a day that is open (weekly hours) AND not an exception-closure. Opening
  // the calendar here — instead of always on today's month — prevents stranding
  // the guest on an all-past month when the salon is viewed late in the month
  // (e.g. the last day: every cell is past/closed and the next availability sits
  // one "next month" click away, invisible). Falls back to the current month
  // when the whole window is closed.
  const firstAvailableMonth = useMemo(() => {
    const week = parseOpeningHours(openingHoursRaw);
    const cursor = new Date(todayStart);
    while (cursor.getTime() <= windowEnd.getTime()) {
      const cfg = week?.[dayKeyFromLocalDate(cursor)];
      const openThatDay = !!cfg && !cfg.closed;
      const exceptionClosed = closedDateYmdSet.has(
        bookingDateYmdFromLocalDate(cursor),
      );
      if (openThatDay && !exceptionClosed) return startOfMonth(cursor);
      cursor.setDate(cursor.getDate() + 1);
    }
    return minMonth;
  }, [openingHoursRaw, closedDateYmdSet, todayStart, windowEnd, minMonth]);

  // View defaults to the selected date's month, or the first available month
  // when nothing is selected yet — never earlier than availability.
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const base = startOfMonth(selectedDate ?? todayStart);
    return base.getTime() < firstAvailableMonth.getTime()
      ? firstAvailableMonth
      : base;
  });

  useEffect(() => {
    if (!selectedDate) return;
    const base = startOfMonth(selectedDate);
    // Never sync to a month before the first available one — keeps a today-default
    // selection from snapping the view back to an all-past current month.
    const candidate =
      base.getTime() < firstAvailableMonth.getTime()
        ? firstAvailableMonth
        : base;
    // Use functional updater so viewMonth is NOT a dep — having it in deps caused
    // clicking "Next Month" to immediately reset back to selectedDate's month:
    // click Next→June, effect fires (viewMonth changed), candidate=May, setViewMonth(May).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- functional updater avoids cascade; this is intentional derived-state sync
    setViewMonth((current) => {
      if (candidate.getTime() === current.getTime()) return current;
      if (
        candidate.getTime() >= minMonth.getTime() &&
        candidate.getTime() <= maxMonth.getTime()
      ) {
        return candidate;
      }
      return current;
    });
  }, [selectedDate, minMonth, maxMonth, firstAvailableMonth]);

  const daysInView = useMemo(() => {
    const out: Date[] = [];
    const first = startOfMonth(viewMonth);
    const next = addMonthsClamped(viewMonth, 1);
    for (let cur = new Date(first); cur < next; cur.setDate(cur.getDate() + 1)) {
      const x = new Date(cur);
      x.setHours(12, 0, 0, 0);
      out.push(x);
    }
    return out;
  }, [viewMonth]);

  // When viewing the CURRENT month, drop the fully-past weeks above the current
  // week so the grid opens on "this week" instead of leading with rows of dimmed
  // past days (Huy: "những ngày quá khứ trống lỗng vậy sao"). Past days that fall
  // inside the current week stay visible but dimmed/disabled — no empty holes.
  // Future months render in full from day 1.
  const gridDays = useMemo(() => {
    const isCurrentMonth =
      viewMonth.getFullYear() === todayStart.getFullYear() &&
      viewMonth.getMonth() === todayStart.getMonth();
    if (!isCurrentMonth) return daysInView;
    const mondayOffset = (todayStart.getDay() + 6) % 7;
    const monday = new Date(todayStart);
    monday.setDate(todayStart.getDate() - mondayOffset);
    const mondayMs = startOfLocalDay(monday).getTime();
    return daysInView.filter(
      (d) => startOfLocalDay(d).getTime() >= mondayMs,
    );
  }, [daysInView, viewMonth, todayStart]);

  // Horizontal "near-term" strip: consecutive days starting TODAY, capped at
  // 14 and never beyond the lead-time horizon. The strip is the default view
  // (fast for soon bookings, no past clutter); the month grid lives behind a
  // toggle. Noon-anchored to match daysInView and dodge DST edges.
  const stripDays = useMemo(() => {
    const count = Math.min(14, Math.max(1, windowDays));
    const out: Date[] = [];
    for (let i = 0; i < count; i++) {
      const x = new Date(todayStart);
      x.setDate(todayStart.getDate() + i);
      x.setHours(12, 0, 0, 0);
      out.push(x);
    }
    return out;
  }, [todayStart, windowDays]);

  // Union of the visible month's days and the strip days (deduped by YMD) so
  // every strip chip gets a correct availability dot — the strip can show days
  // from a month the grid isn't currently viewing.
  const probeDays = useMemo(() => {
    const seen = new Set<string>();
    const out: Date[] = [];
    for (const d of [...gridDays, ...stripDays]) {
      const ymd = bookingDateYmdFromLocalDate(d);
      if (seen.has(ymd)) continue;
      seen.add(ymd);
      out.push(d);
    }
    return out;
  }, [gridDays, stripDays]);

  // Show the full month grid by default only when the current selection sits
  // past the strip range (far-future pick) — otherwise the strip covers it and
  // the grid stays collapsed. Computed once on mount; the toggle drives it after.
  const [showGrid, setShowGrid] = useState<boolean>(() => {
    if (!selectedDate) return false;
    const lastStripDay = stripDays[stripDays.length - 1]!;
    return (
      startOfLocalDay(selectedDate).getTime() >
      startOfLocalDay(lastStripDay).getTime()
    );
  });

  const week = parseOpeningHours(openingHoursRaw);

  function weekdayClosed(d: Date): boolean {
    if (!week) return true;
    const k = dayKeyFromLocalDate(d);
    const cfg = week[k];
    return !cfg || cfg.closed;
  }
  function isExceptionClosed(d: Date): boolean {
    return closedDateYmdSet.has(bookingDateYmdFromLocalDate(d));
  }
  function dayClosed(d: Date): boolean {
    return weekdayClosed(d) || isExceptionClosed(d);
  }

  // Per-day open-slot COUNT (not just boolean) so the dot can colour by tier
  // and "full" (open but 0 slots) days can be disabled. Key present only for
  // probed, open, in-window days; absence = unknown (still loading).
  const [slotCountByYmd, setSlotCountByYmd] = useState<Record<string, number>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    if (!salonId || serviceTotalMinutes <= 0 || staff.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale slot counts when inputs become incomplete
      setSlotCountByYmd({});
      return;
    }
    void (async () => {
      const results = await Promise.all(
        probeDays.map(async (date) => {
          const ymd = bookingDateYmdFromLocalDate(date);
          const past = startOfLocalDay(date).getTime() < todayStart.getTime();
          const beyondWindow =
            startOfLocalDay(date).getTime() >
            startOfLocalDay(windowEnd).getTime();
          if (past || beyondWindow || dayClosed(date)) {
            return { ymd, count: null as number | null };
          }
          const n = await getAvailableTimeSlotsCount({
            salonId,
            openingHoursRaw,
            selectedDate: date,
            staffId,
            staffList: staff,
            serviceDurationMinutes: serviceTotalMinutes,
            closedDateYmdSet,
          });
          return { ymd, count: n };
        }),
      );
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const r of results) if (r.count !== null) next[r.ymd] = r.count;
      setSlotCountByYmd(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dayClosed is a render-time function whose inputs (openingHoursRaw, closedDateYmdSet) are already in deps
  }, [
    salonId,
    openingHoursRaw,
    closedDateYmdSet,
    staff,
    staffId,
    serviceTotalMinutes,
    probeDays,
    todayStart,
    windowEnd,
  ]);

  const first = gridDays[0]!;
  const leadPad = (first.getDay() + 6) % 7;

  type Cell =
    | { kind: "empty" }
    | {
        kind: "day";
        date: Date;
        closed: boolean;
        exceptionClosed: boolean;
        past: boolean;
        beyondWindow: boolean;
        isToday: boolean;
      };
  const cells: Cell[] = [];
  for (let i = 0; i < leadPad; i++) cells.push({ kind: "empty" });
  for (const date of gridDays) {
    const startMs = startOfLocalDay(date).getTime();
    const past = startMs < todayStart.getTime();
    const beyondWindow = startMs > startOfLocalDay(windowEnd).getTime();
    const exception = isExceptionClosed(date);
    const weekly = weekdayClosed(date);
    cells.push({
      kind: "day",
      date,
      closed: weekly || exception,
      exceptionClosed: exception,
      past,
      beyondWindow,
      isToday: sameLocalCalendarDay(date, new Date()),
    });
  }
  while (cells.length % 7 !== 0) cells.push({ kind: "empty" });

  const canPrev = viewMonth.getTime() > minMonth.getTime();
  const canNext = viewMonth.getTime() < maxMonth.getTime();

  // Earliest probed, in-window day that still has at least one open slot →
  // powers the "soonest available" jump button. Probed set always covers the
  // next 14 days (strip) plus the visible month, so a near-term opening is found
  // even when this week is full.
  const soonestAvailable = useMemo(() => {
    let best: Date | null = null;
    for (const d of probeDays) {
      const c = slotCountByYmd[bookingDateYmdFromLocalDate(d)];
      if (c !== undefined && c > 0 && (!best || d.getTime() < best.getTime())) {
        best = d;
      }
    }
    return best;
  }, [probeDays, slotCountByYmd]);

  const soonestSelected =
    soonestAvailable !== null &&
    selectedDate !== null &&
    sameLocalCalendarDay(soonestAvailable, selectedDate);

  function jumpToSoonest() {
    if (!soonestAvailable) return;
    onSelectDate(soonestAvailable);
    const m = startOfMonth(soonestAvailable);
    if (m.getTime() >= minMonth.getTime() && m.getTime() <= maxMonth.getTime()) {
      setViewMonth(m);
    }
  }

  return (
    <div className="mt-2">
      {/* "Soonest available" jump — appears when a near-term opening exists and
          isn't already the picked day. Lets a guest skip a full this-week. */}
      {soonestAvailable && !soonestSelected ? (
        <button
          type="button"
          data-testid="calendar-soonest"
          onClick={jumpToSoonest}
          className="mb-2 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors"
          style={{
            borderColor: "color-mix(in srgb, " + TIER_DOT_COLOR.open + " 45%, transparent)",
            color: TIER_DOT_COLOR.open,
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: TIER_DOT_COLOR.open }}
            aria-hidden
          />
          {t.calendarSoonest}: {calendarDayAbbrev(soonestAvailable)}{" "}
          {soonestAvailable.getDate()}/{soonestAvailable.getMonth() + 1}
        </button>
      ) : null}

      {/* Near-term horizontal date strip — default fast path, no past days. */}
      <div
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid="date-strip"
      >
        {stripDays.map((date, idx) => {
          const ymd = bookingDateYmdFromLocalDate(date);
          const startMs = startOfLocalDay(date).getTime();
          const beyondWindow = startMs > startOfLocalDay(windowEnd).getTime();
          const closed = dayClosed(date);
          const count = slotCountByYmd[ymd];
          const tier = count === undefined ? null : tierFromCount(count);
          const full = tier === "full";
          const disabled = beyondWindow || closed || full;
          const selected =
            selectedDate !== null && sameLocalCalendarDay(date, selectedDate);
          const exceptionClosed = isExceptionClosed(date);
          const isFirst = idx === 0;
          // Coloured dot for any open day with a known tier (incl. red "full").
          const dotColor =
            !beyondWindow && !closed && tier ? TIER_DOT_COLOR[tier] : null;
          const topLabel = isFirst
            ? t.dateTodayChip
            : closed
              ? exceptionClosed
                ? t.dateHolidayShort
                : t.dateClosedShort
              : calendarDayAbbrev(date);

          return (
            <button
              key={date.toISOString()}
              type="button"
              data-testid="date-strip-day"
              data-ymd={ymd}
              disabled={disabled}
              aria-pressed={selected}
              aria-label={`${String(date.getDate())} ${calendarDayAbbrev(date)}${
                closed
                  ? exceptionClosed
                    ? ` ${t.dateHolidayLabel}`
                    : ` ${t.dateClosedLabel}`
                  : ""
              }`}
              onClick={() => onSelectDate(date)}
              className={cn(
                "flex min-h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl border px-1 py-2 text-center transition-colors",
                disabled && "cursor-not-allowed opacity-35",
                !disabled &&
                  !selected &&
                  "nq-booking-tile-interactive border-[var(--booking-border)] bg-[var(--booking-bg-input)] hover:border-[var(--booking-border)]",
                selected &&
                  !disabled &&
                  "border-[var(--salon-primary)] bg-[var(--salon-primary)] text-[var(--booking-bg)] shadow-[0_0_24px_-10px_color-mix(in_srgb,var(--salon-primary)_55%,transparent)]",
              )}
            >
              <span
                className={cn(
                  "text-[10px] font-medium uppercase leading-none sm:text-[11px]",
                  selected
                    ? "text-[var(--booking-bg)]/90"
                    : "text-[var(--booking-text-muted)]",
                )}
              >
                {topLabel}
              </span>
              <span
                className={cn(
                  "mt-0.5 text-[13px] font-semibold tabular-nums sm:text-sm",
                  selected
                    ? "text-[var(--booking-bg)]"
                    : "text-[var(--booking-text)]",
                )}
              >
                {date.getDate()}
              </span>
              {dotColor && !selected ? (
                <div
                  className="mx-auto mt-1 h-1 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                  aria-hidden
                />
              ) : (
                <span
                  className="mt-1 block h-1 w-1 shrink-0 opacity-0"
                  aria-hidden
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Toggle to reveal the full month grid for far-future booking. */}
      <div className="mt-3 flex justify-center">
        <button
          type="button"
          data-testid="date-toggle-calendar"
          aria-expanded={showGrid}
          onClick={() => setShowGrid((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--booking-border)] px-3 py-1.5 text-[13px] font-medium text-[var(--booking-text-muted)] transition-colors hover:border-[var(--salon-primary)] hover:text-[var(--salon-primary)]"
        >
          📅 {showGrid ? t.dateHideCalendar : t.dateMoreDates}
        </button>
      </div>

      {showGrid && (
        <div className="mt-3">
      <div className="mb-3 flex items-center justify-between gap-3 sm:mb-4">
        <button
          type="button"
          data-testid="calendar-prev-month"
          disabled={!canPrev}
          onClick={() => {
            if (canPrev) setViewMonth(addMonthsClamped(viewMonth, -1));
          }}
          aria-label={t.calendarPrevMonthAria}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--booking-border)] text-[var(--booking-text)] transition-colors",
            canPrev
              ? "hover:border-[var(--booking-border)] hover:bg-[var(--booking-bg-input)]"
              : "cursor-not-allowed opacity-40",
          )}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div
          className="text-sm font-semibold tracking-tight text-[var(--booking-text)] sm:text-base"
          aria-live="polite"
          data-testid="calendar-month-label"
        >
          {monthHeaderLabel(viewMonth)}
        </div>
        <button
          type="button"
          data-testid="calendar-next-month"
          disabled={!canNext}
          onClick={() => {
            if (canNext) setViewMonth(addMonthsClamped(viewMonth, 1));
          }}
          aria-label={t.calendarNextMonthAria}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--booking-border)] text-[var(--booking-text)] transition-colors",
            canNext
              ? "hover:border-[var(--booking-border)] hover:bg-[var(--booking-bg-input)]"
              : "cursor-not-allowed opacity-40",
          )}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      <div
        className="grid grid-cols-7 gap-1.5 text-center sm:gap-2"
        data-testid="calendar-grid"
      >
        {WEEK_HDR.map((h) => (
          <div
            key={h}
            className="pb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--booking-text-muted)] sm:text-xs"
          >
            {h}
          </div>
        ))}
        {cells.map((cell, idx) => {
          if (cell.kind === "empty") {
            return (
              <div
                key={`e-${idx}`}
                className="min-h-11 sm:min-h-[3rem]"
                aria-hidden
              />
            );
          }
          const { date, closed, exceptionClosed, past, beyondWindow, isToday } =
            cell;
          const selected =
            selectedDate !== null && sameLocalCalendarDay(date, selectedDate);
          const ymd = bookingDateYmdFromLocalDate(date);
          const count = slotCountByYmd[ymd];
          const tier =
            past || beyondWindow || closed || count === undefined
              ? null
              : tierFromCount(count);
          const full = tier === "full";
          const disabled = past || beyondWindow || closed || full;
          const labelDay = String(date.getDate());
          const abbrev = calendarDayAbbrev(date);
          const dotColor = tier ? TIER_DOT_COLOR[tier] : null;

          return (
            <button
              key={date.toISOString()}
              type="button"
              data-testid={isToday ? "date-today" : "date-day"}
              // e2e helper handle — lets specs pick a specific YMD
              // without needing weekday-abbrev or day-number parsing.
              data-ymd={ymd}
              data-past={past ? "true" : undefined}
              disabled={disabled}
              aria-pressed={selected}
              aria-label={`${labelDay} ${abbrev}${
                closed
                  ? exceptionClosed && !past
                    ? ` ${t.dateHolidayLabel}`
                    : ` ${t.dateClosedLabel}`
                  : ""
              }`}
              onClick={() => onSelectDate(date)}
              className={cn(
                "flex min-h-11 flex-col items-center justify-center rounded-xl border px-0.5 py-2 text-center transition-colors sm:min-h-[3rem]",
                disabled && "cursor-not-allowed opacity-35",
                !disabled &&
                  !selected &&
                  "nq-booking-tile-interactive border-[var(--booking-border)] hover:border-[var(--booking-border)]",
                closed && !past && !beyondWindow && "opacity-45",
                !disabled &&
                  !selected &&
                  !closed &&
                  "border-[var(--booking-border)] bg-[var(--booking-bg-input)]",
                isToday &&
                  !selected &&
                  !disabled &&
                  "ring-1 ring-[color-mix(in_srgb,var(--salon-primary)_55%,transparent)] ring-offset-2 ring-offset-[var(--booking-bg)]",
                selected &&
                  !disabled &&
                  "border-[var(--salon-primary)] bg-[var(--salon-primary)] text-[var(--booking-bg)] shadow-[0_0_24px_-10px_color-mix(in_srgb,var(--salon-primary)_55%,transparent)]",
              )}
            >
              <span
                className={cn(
                  "text-[10px] font-medium uppercase leading-none sm:text-[11px]",
                  selected
                    ? "text-[var(--booking-bg)]/90"
                    : "text-[var(--booking-text-muted)]",
                )}
              >
                {closed && !past
                  ? exceptionClosed
                    ? t.dateHolidayShort
                    : t.dateClosedShort
                  : abbrev}
              </span>
              <span
                className={cn(
                  "mt-0.5 text-[13px] font-semibold tabular-nums sm:text-sm",
                  selected
                    ? "text-[var(--booking-bg)]"
                    : "text-[var(--booking-text)]",
                )}
              >
                {labelDay}
              </span>
              {dotColor && !selected ? (
                <div
                  className="mt-1 h-1 w-1 shrink-0 rounded-full mx-auto"
                  style={{ backgroundColor: dotColor }}
                  aria-hidden
                />
              ) : (
                <span
                  className="mt-1 block h-1 w-1 shrink-0 opacity-0"
                  aria-hidden
                />
              )}
            </button>
          );
        })}
      </div>

      <div
        className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[11px] text-[var(--booking-text-muted)] sm:text-xs"
        data-testid="calendar-legend"
      >
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: TIER_DOT_COLOR.open }}
            aria-hidden
          />
          {t.calendarLegendAvailable}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: TIER_DOT_COLOR.limited }}
            aria-hidden
          />
          {t.calendarLegendLimited}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: TIER_DOT_COLOR.full }}
            aria-hidden
          />
          {t.calendarLegendFull}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-nq-muted/45"
            aria-hidden
          />
          {t.calendarLegendClosed}
        </span>
      </div>
        </div>
      )}
    </div>
  );
}
