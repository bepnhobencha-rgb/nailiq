"use client";

import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";
import { bookingDateYmdFromLocalDate } from "@/shared/booking/bookingConfirmLabels";
import { getAvailableTimeSlotsCount } from "@/shared/booking/getAvailableTimeSlots";
import type { BookingStaffItem } from "@/shared/booking/loadBookingServices";
import { useEffect, useMemo, useState } from "react";

const WEEK_HDR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
/** Public booking lead time. */
const BOOKING_WINDOW_DAYS = 60;

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

export function BookingFlowDatePanel({
  t,
  salonId,
  openingHoursRaw,
  closedDateYmdSet,
  staff,
  staffId,
  serviceTotalMinutes,
  selectedDate,
  stepDir,
  reducedMotion,
  stepTransition,
  onSelectDate,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  salonId: string;
  openingHoursRaw: unknown | null;
  closedDateYmdSet: ReadonlySet<string>;
  staff: readonly BookingStaffItem[];
  staffId: string;
  /** Primary service total minutes for slot hints (same model as time step). */
  serviceTotalMinutes: number;
  selectedDate: Date;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onSelectDate: (d: Date) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const todayStart = useMemo(() => startOfLocalDay(new Date()), []);
  /** Last day the user is allowed to book (inclusive). */
  const windowEnd = useMemo(() => {
    const x = new Date(todayStart);
    x.setDate(todayStart.getDate() + BOOKING_WINDOW_DAYS - 1);
    return x;
  }, [todayStart]);

  const minMonth = useMemo(() => startOfMonth(todayStart), [todayStart]);
  const maxMonth = useMemo(() => startOfMonth(windowEnd), [windowEnd]);

  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(selectedDate));

  // Keep view in sync if the selection ever lands on a different month.
  useEffect(() => {
    const candidate = startOfMonth(selectedDate);
    if (candidate.getTime() !== viewMonth.getTime()) {
      if (
        candidate.getTime() >= minMonth.getTime() &&
        candidate.getTime() <= maxMonth.getTime()
      ) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- pull viewMonth back into range when selectedDate jumps
        setViewMonth(candidate);
      }
    }
  }, [selectedDate, viewMonth, minMonth, maxMonth]);

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

  const [slotHintByYmd, setSlotHintByYmd] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    let cancelled = false;
    if (!salonId || serviceTotalMinutes <= 0 || staff.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale slot hints when inputs become incomplete
      setSlotHintByYmd({});
      return;
    }

    void (async () => {
      const results = await Promise.all(
        daysInView.map(async (date) => {
          const ymd = bookingDateYmdFromLocalDate(date);
          const past = startOfLocalDay(date).getTime() < todayStart.getTime();
          const beyondWindow =
            startOfLocalDay(date).getTime() >
            startOfLocalDay(windowEnd).getTime();
          if (past || beyondWindow || dayClosed(date)) {
            return { ymd, hasSlots: false };
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
          return { ymd, hasSlots: n > 0 };
        }),
      );

      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const r of results) {
        next[r.ymd] = r.hasSlots;
      }
      setSlotHintByYmd(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [
    salonId,
    openingHoursRaw,
    closedDateYmdSet,
    staff,
    staffId,
    serviceTotalMinutes,
    daysInView,
    todayStart,
    windowEnd,
  ]);

  const first = daysInView[0]!;
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
  for (let i = 0; i < leadPad; i++) {
    cells.push({ kind: "empty" });
  }
  for (const date of daysInView) {
    const startMs = startOfLocalDay(date).getTime();
    const past = startMs < todayStart.getTime();
    const beyondWindow = startMs > startOfLocalDay(windowEnd).getTime();
    const exception = isExceptionClosed(date);
    const weekly = weekdayClosed(date);
    const closed = weekly || exception;
    cells.push({
      kind: "day",
      date,
      closed,
      exceptionClosed: exception,
      past,
      beyondWindow,
      isToday: sameLocalCalendarDay(date, new Date()),
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ kind: "empty" });
  }

  const selectionValid =
    !dayClosed(selectedDate) &&
    startOfLocalDay(selectedDate).getTime() >= todayStart.getTime() &&
    startOfLocalDay(selectedDate).getTime() <=
      startOfLocalDay(windowEnd).getTime();

  const canPrev = viewMonth.getTime() > minMonth.getTime();
  const canNext = viewMonth.getTime() < maxMonth.getTime();

  return (
    <motion.section
      key="date"
      role="group"
      aria-labelledby="date-heading"
      custom={stepDir}
      variants={bookingStepVariants}
      initial={reducedMotion ? false : "initial"}
      animate="animate"
      exit="exit"
      transition={stepTransition}
      className="will-change-transform"
    >
      <h2
        id="date-heading"
        className="text-lg font-semibold tracking-tight text-[var(--booking-text)] sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
      >
        {t.stepDateHeading}
      </h2>

      <div className="mt-6 lg:mt-8">
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
                <div key={`e-${idx}`} className="min-h-11 sm:min-h-[3rem]" aria-hidden />
              );
            }

            const { date, closed, exceptionClosed, past, beyondWindow, isToday } =
              cell;
            const selected = sameLocalCalendarDay(date, selectedDate);
            const disabled = past || beyondWindow || closed;
            const labelDay = String(date.getDate());
            const abbrev = calendarDayAbbrev(date);
            const ymd = bookingDateYmdFromLocalDate(date);
            const hasSlotsHint =
              !past && !beyondWindow && !closed && slotHintByYmd[ymd] === true;

            return (
              <button
                key={date.toISOString()}
                type="button"
                data-testid={isToday ? "date-today" : "date-day"}
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
                  !disabled && !selected && "nq-booking-tile-interactive border-[var(--booking-border)] hover:border-[var(--booking-border)]",
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
                    "text-[13px] font-semibold tabular-nums sm:text-sm",
                    selected ? "text-[var(--booking-bg)]" : "text-[var(--booking-text)]",
                  )}
                >
                  {labelDay}
                </span>
                <span
                  className={cn(
                    "mt-0.5 text-[10px] font-medium uppercase leading-none sm:text-[11px]",
                    selected ? "text-[var(--booking-bg)]/90" : "text-[var(--booking-text-muted)]",
                  )}
                >
                  {closed && !past
                    ? exceptionClosed
                      ? t.dateHolidayShort
                      : t.dateClosedShort
                    : abbrev}
                </span>
                {hasSlotsHint ? (
                  <div
                    className="mt-1 h-1 w-1 shrink-0 rounded-full bg-[var(--salon-primary)] mx-auto"
                    aria-hidden
                  />
                ) : (
                  <span className="mt-1 block h-1 w-1 shrink-0 opacity-0" aria-hidden />
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
              className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--salon-primary)]"
              aria-hidden
            />
            {t.calendarLegendAvailable}
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

      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:gap-4 lg:mt-12 lg:items-center lg:justify-between">
        <Button
          type="button"
          variant="secondary"
          className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-[var(--booking-border)] text-[var(--salon-primary)] shadow-none hover:bg-[var(--booking-bg-input)] sm:w-auto sm:min-w-[8.5rem]"
          onClick={onBack}
        >
          {t.back}
        </Button>
        <div className="flex w-full justify-end sm:flex-1">
          <LuxuryBookingCta disabled={!selectionValid} onClick={onNext}>
            {t.next}
          </LuxuryBookingCta>
        </div>
      </div>
    </motion.section>
  );
}
