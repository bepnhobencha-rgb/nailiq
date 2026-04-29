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
  const { todayStart, daysForward } = useMemo(() => {
    const ts = startOfLocalDay(new Date());
    const out: Date[] = [];
    for (let i = 0; i < 14; i++) {
      const x = new Date(ts);
      x.setDate(ts.getDate() + i);
      x.setHours(12, 0, 0, 0);
      out.push(x);
    }
    return { todayStart: ts, daysForward: out };
  }, []);

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
      setSlotHintByYmd({});
      return;
    }

    void (async () => {
      const results = await Promise.all(
        daysForward.map(async (date) => {
          const ymd = bookingDateYmdFromLocalDate(date);
          if (dayClosed(date)) {
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
    daysForward,
  ]);

  const first = daysForward[0]!;
  const leadPad = (first.getDay() + 6) % 7;

  type Cell =
    | { kind: "empty" }
    | {
        kind: "day";
        date: Date;
        closed: boolean;
        exceptionClosed: boolean;
        past: boolean;
        isToday: boolean;
      };

  const cells: Cell[] = [];
  for (let i = 0; i < leadPad; i++) {
    cells.push({ kind: "empty" });
  }
  for (const date of daysForward) {
    const past = startOfLocalDay(date).getTime() < todayStart.getTime();
    const exception = isExceptionClosed(date);
    const weekly = weekdayClosed(date);
    const closed = weekly || exception;
    cells.push({
      kind: "day",
      date,
      closed,
      exceptionClosed: exception,
      past,
      isToday: sameLocalCalendarDay(date, new Date()),
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ kind: "empty" });
  }

  const selectionValid =
    !dayClosed(selectedDate) &&
    startOfLocalDay(selectedDate).getTime() >= todayStart.getTime();

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
        className="text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
      >
        {t.stepDateHeading}
      </h2>

      <div className="mt-6 lg:mt-8">
        <div className="grid grid-cols-7 gap-1.5 text-center sm:gap-2">
          {WEEK_HDR.map((h) => (
            <div
              key={h}
              className="pb-2 text-[11px] font-semibold uppercase tracking-wide text-nq-muted sm:text-xs"
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

            const { date, closed, exceptionClosed, past, isToday } = cell;
            const selected = sameLocalCalendarDay(date, selectedDate);
            const disabled = past || closed;
            const labelDay = String(date.getDate());
            const abbrev = calendarDayAbbrev(date);
            const ymd = bookingDateYmdFromLocalDate(date);
            const hasSlotsHint =
              !past && !closed && slotHintByYmd[ymd] === true;

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
                  !disabled && !selected && "nq-booking-tile-interactive border-white/[0.06] hover:border-white/[0.12]",
                  closed && !past && "opacity-45",
                  !disabled &&
                    !selected &&
                    !closed &&
                    "border-white/[0.06] bg-white/[0.02]",
                  isToday &&
                    !selected &&
                    !disabled &&
                    "ring-1 ring-nq-primary/55 ring-offset-2 ring-offset-nq-bg",
                  selected &&
                    !disabled &&
                    "border-nq-primary bg-nq-primary text-nq-bg shadow-[0_0_24px_-10px_rgba(212,175,55,0.55)]",
                )}
              >
                <span
                  className={cn(
                    "text-[13px] font-semibold tabular-nums sm:text-sm",
                    selected ? "text-nq-bg" : "text-nq-foreground",
                  )}
                >
                  {labelDay}
                </span>
                <span
                  className={cn(
                    "mt-0.5 text-[10px] font-medium uppercase leading-none sm:text-[11px]",
                    selected ? "text-nq-bg/90" : "text-nq-muted",
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
                    className="mt-1 h-1 w-1 shrink-0 rounded-full bg-nq-primary mx-auto"
                    aria-hidden
                  />
                ) : (
                  <span className="mt-1 block h-1 w-1 shrink-0 opacity-0" aria-hidden />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:gap-4 lg:mt-12 lg:items-center lg:justify-between">
        <Button
          type="button"
          variant="secondary"
          className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-white/[0.08] text-nq-primary shadow-none hover:bg-white/[0.04] sm:w-auto sm:min-w-[8.5rem]"
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
