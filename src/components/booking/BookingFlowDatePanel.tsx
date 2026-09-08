"use client";

import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import { BookingCalendarGrid } from "@/components/booking/BookingCalendarGrid";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";
import { bookingDateYmdFromLocalDate } from "@/shared/booking/bookingConfirmLabels";
import type { BookingStaffItem } from "@/shared/booking/loadBookingServices";
import { useMemo } from "react";
import { salonTodayCalendarDate } from "@/shared/booking/salonCalendarDate";

/** Public booking lead time. */
const BOOKING_WINDOW_DAYS = 60;

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function BookingFlowDatePanel({
  t,
  salonId,
  salonTimezone,
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
  language,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  salonId: string;
  salonTimezone: string;
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
  language: "en" | "vi";
  onBack: () => void;
  onNext: () => void;
}) {
  const todayStart = useMemo(
    () => startOfLocalDay(salonTodayCalendarDate(salonTimezone)),
    [salonTimezone],
  );
  /** Last day the user is allowed to book (inclusive). */
  const windowEnd = useMemo(() => {
    const x = new Date(todayStart);
    x.setDate(todayStart.getDate() + BOOKING_WINDOW_DAYS - 1);
    return x;
  }, [todayStart]);

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

  // Continue is enabled when the current selection isn't past /
  // beyond-window / closed. The grid renders those cells as
  // disabled, but the user might have arrived with a stale
  // selection from sessionStorage or earlier step state.
  const selectionValid =
    !dayClosed(selectedDate) &&
    startOfLocalDay(selectedDate).getTime() >= todayStart.getTime() &&
    startOfLocalDay(selectedDate).getTime() <=
      startOfLocalDay(windowEnd).getTime();

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
        <BookingCalendarGrid
          t={t}
          salonId={salonId}
          salonTimezone={salonTimezone}
          openingHoursRaw={openingHoursRaw}
          closedDateYmdSet={closedDateYmdSet}
          staff={staff}
          staffId={staffId}
          serviceTotalMinutes={serviceTotalMinutes}
          selectedDate={selectedDate}
          windowDays={BOOKING_WINDOW_DAYS}
          onSelectDate={onSelectDate}
          language={language}
        />
      </div>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:gap-4 lg:mt-12 lg:items-center lg:justify-between">
        <Button
          type="button"
          variant="secondary"
          className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none hover:bg-[var(--booking-bg-input)] sm:w-auto sm:min-w-[8.5rem]"
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
