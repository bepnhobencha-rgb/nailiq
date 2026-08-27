"use client";

import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { ymdToLocalDate } from "@/shared/lib/localDateYmd";
import type { ReceptionistCalendarViewMode } from "./CalendarViewModeControl";
import { firstOfMonth } from "./MonthView";
import { mondayYmdOf, shiftWeek } from "./WeekView";

type PeriodLabels = Record<ReceptionistCalendarViewMode, string>;

export interface ShellV2DateNavigatorProps {
  mode: ReceptionistCalendarViewMode;
  dayYmd: string;
  weekMondayYmd: string;
  monthFirstYmd: string;
  todayYmd: string;
  language: "en" | "vi";
  labels: {
    chooseDate: string;
    previous: PeriodLabels;
    next: PeriodLabels;
    current: PeriodLabels;
  };
  disabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onCurrent: () => void;
  onSelectDate: (ymd: string) => void;
}

function formatDay(ymd: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(ymdToLocalDate(ymd));
}

function formatWeek(mondayYmd: string, locale: string): string {
  const nextMonday = ymdToLocalDate(shiftWeek(mondayYmd, 1));
  nextMonday.setDate(nextMonday.getDate() - 1);
  const monday = ymdToLocalDate(mondayYmd);
  const sameMonth =
    monday.getFullYear() === nextMonday.getFullYear() &&
    monday.getMonth() === nextMonday.getMonth();

  if (sameMonth) {
    const month = new Intl.DateTimeFormat(locale, { month: "long" }).format(
      monday,
    );
    return `${month} ${monday.getDate()}–${nextMonday.getDate()}, ${nextMonday.getFullYear()}`;
  }

  const start = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(monday);
  const end = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(nextMonday);
  return `${start} – ${end}`;
}

function formatMonth(firstYmd: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  }).format(ymdToLocalDate(firstYmd));
}

/**
 * One calm answer to three desk questions:
 * - arrows move the visible period;
 * - the centre label opens an exact-date picker;
 * - the contextual reset appears only after leaving the current period.
 *
 * Shell V2 only. Classic keeps its established Yesterday/Today/Tomorrow
 * muscle memory as the immediate rollback path.
 */
export function ShellV2DateNavigator({
  mode,
  dayYmd,
  weekMondayYmd,
  monthFirstYmd,
  todayYmd,
  language,
  labels,
  disabled = false,
  onPrevious,
  onNext,
  onCurrent,
  onSelectDate,
}: ShellV2DateNavigatorProps) {
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const anchorYmd =
    mode === "day"
      ? dayYmd
      : mode === "week"
        ? weekMondayYmd
        : monthFirstYmd;
  const currentAnchor =
    mode === "day"
      ? todayYmd
      : mode === "week"
        ? mondayYmdOf(todayYmd)
        : firstOfMonth(todayYmd);
  const displayLabel =
    mode === "day"
      ? formatDay(dayYmd, locale)
      : mode === "week"
        ? formatWeek(weekMondayYmd, locale)
        : formatMonth(monthFirstYmd, locale);
  const isCurrentPeriod = anchorYmd === currentAnchor;

  return (
    <nav
      data-testid="shell-v2-date-navigator"
      aria-label={labels.chooseDate}
      className="flex min-w-0 items-center gap-1.5"
    >
      <button
        type="button"
        data-testid="shell-v2-date-previous"
        aria-label={labels.previous[mode]}
        title={labels.previous[mode]}
        disabled={disabled}
        onClick={onPrevious}
        className={cn(
          "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-nq-muted/35 bg-nq-surface text-nq-muted transition-colors",
          "hover:border-nq-primary/40 hover:text-nq-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
          "disabled:pointer-events-none disabled:opacity-45",
        )}
      >
        <ChevronLeft className="h-5 w-5" aria-hidden />
      </button>

      <details className="group relative min-w-0">
        <summary
          data-testid="shell-v2-date-label"
          aria-label={`${labels.chooseDate}: ${displayLabel}`}
          className={cn(
            "inline-flex min-h-11 max-w-[min(26rem,52vw)] min-w-0 cursor-pointer list-none items-center gap-2 rounded-full border border-nq-muted/35 bg-nq-surface px-3 text-nq-foreground transition-colors",
            "hover:border-nq-primary/40 hover:text-nq-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
            "[&::-webkit-details-marker]:hidden",
          )}
        >
          <CalendarDays className="h-4 w-4 shrink-0 text-nq-primary" aria-hidden />
          <span className="truncate text-xs font-semibold capitalize sm:text-sm">
            {displayLabel}
          </span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-nq-muted transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <div
          data-testid="shell-v2-date-picker"
          className="absolute left-0 top-full z-50 mt-2 w-72 rounded-2xl border border-nq-border bg-nq-surface p-3 shadow-xl"
        >
          <label
            htmlFor="shell-v2-date-input"
            className="mb-2 block text-xs font-semibold text-nq-muted"
          >
            {labels.chooseDate}
          </label>
          <input
            id="shell-v2-date-input"
            type="date"
            value={anchorYmd}
            data-testid="shell-v2-date-input"
            onChange={(event) => {
              if (!event.target.value) return;
              onSelectDate(event.target.value);
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
            className="min-h-11 w-full rounded-xl border border-nq-border bg-nq-surface px-3 text-sm font-medium text-nq-foreground outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
          />
        </div>
      </details>

      <button
        type="button"
        data-testid="shell-v2-date-next"
        aria-label={labels.next[mode]}
        title={labels.next[mode]}
        disabled={disabled}
        onClick={onNext}
        className={cn(
          "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-nq-muted/35 bg-nq-surface text-nq-muted transition-colors",
          "hover:border-nq-primary/40 hover:text-nq-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
          "disabled:pointer-events-none disabled:opacity-45",
        )}
      >
        <ChevronRight className="h-5 w-5" aria-hidden />
      </button>

      {!isCurrentPeriod ? (
        <button
          type="button"
          data-testid="shell-v2-date-current"
          disabled={disabled}
          onClick={onCurrent}
          className="min-h-11 shrink-0 rounded-full border border-nq-primary/40 bg-nq-primary/10 px-3 text-xs font-semibold text-nq-primary transition-colors hover:bg-nq-primary/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45 disabled:pointer-events-none disabled:opacity-45 sm:text-sm"
        >
          {labels.current[mode]}
        </button>
      ) : null}
    </nav>
  );
}
