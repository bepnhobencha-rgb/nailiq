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
  openingHoursRaw,
  selectedDate,
  stepDir,
  reducedMotion,
  stepTransition,
  onSelectDate,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  openingHoursRaw: unknown | null;
  selectedDate: Date;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onSelectDate: (d: Date) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const todayStart = startOfLocalDay(new Date());

  const daysForward: Date[] = [];
  for (let i = 0; i < 14; i++) {
    const x = new Date(todayStart);
    x.setDate(todayStart.getDate() + i);
    x.setHours(12, 0, 0, 0);
    daysForward.push(x);
  }

  const week = parseOpeningHours(openingHoursRaw);

  function dayClosed(d: Date): boolean {
    if (!week) return true;
    const k = dayKeyFromLocalDate(d);
    const cfg = week[k];
    return !cfg || cfg.closed;
  }

  const first = daysForward[0]!;
  const leadPad = (first.getDay() + 6) % 7;

  type Cell =
    | { kind: "empty" }
    | {
        kind: "day";
        date: Date;
        closed: boolean;
        past: boolean;
        isToday: boolean;
      };

  const cells: Cell[] = [];
  for (let i = 0; i < leadPad; i++) {
    cells.push({ kind: "empty" });
  }
  for (const date of daysForward) {
    const past = startOfLocalDay(date).getTime() < todayStart.getTime();
    cells.push({
      kind: "day",
      date,
      closed: dayClosed(date),
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

            const { date, closed, past, isToday } = cell;
            const selected = sameLocalCalendarDay(date, selectedDate);
            const disabled = past || closed;
            const labelDay = String(date.getDate());
            const abbrev = calendarDayAbbrev(date);

            return (
              <button
                key={date.toISOString()}
                type="button"
                disabled={disabled}
                aria-pressed={selected}
                aria-label={`${labelDay} ${abbrev}${closed ? ` ${t.dateClosedLabel}` : ""}`}
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
                  {closed && !past ? t.dateClosedShort : abbrev}
                </span>
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
