"use client";

import { CalendarDays, ChevronDown } from "lucide-react";

import { cn } from "@/shared/lib/cn";

export type ReceptionistCalendarViewMode = "day" | "week" | "month";

type CalendarViewModeControlProps = {
  value: ReceptionistCalendarViewMode;
  labels: {
    ariaLabel: string;
    day: string;
    week: string;
    month: string;
  };
  language: "en" | "vi";
  onChange: (mode: ReceptionistCalendarViewMode) => void;
};

const MODES: ReceptionistCalendarViewMode[] = ["day", "week", "month"];

/**
 * Always-available calendar-view navigation for Receptionist Shell V2.
 * Wide desks get a one-tap segmented control; iPad and phone widths collapse
 * to a calm 44px menu so the date controls never compete with Create.
 */
export function CalendarViewModeControl({
  value,
  labels,
  language,
  onChange,
}: CalendarViewModeControlProps) {
  const calendarLabel = language === "vi" ? "Lịch" : "Calendar";

  return (
    <>
      <div
        role="tablist"
        aria-label={labels.ariaLabel}
        data-testid="shell-v2-calendar-view-tabs"
        className="hidden overflow-hidden rounded-full border border-nq-muted/35 bg-nq-surface p-0.5 text-sm font-semibold xl:inline-flex"
      >
        {MODES.map((mode) => {
          const active = value === mode;
          return (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`shell-v2-calendar-view-${mode}`}
              onClick={() => onChange(mode)}
              className={cn(
                "min-h-10 rounded-full px-3.5 transition-colors",
                active
                  ? "bg-nq-primary/18 text-nq-primary"
                  : "text-nq-muted hover:text-nq-foreground",
              )}
            >
              {labels[mode]}
            </button>
          );
        })}
      </div>

      <details className="group relative xl:hidden">
        <summary
          data-testid="shell-v2-calendar-view-menu-trigger"
          aria-label={`${labels.ariaLabel}: ${labels[value]}`}
          className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full border border-nq-muted/35 bg-nq-surface px-3 text-sm font-semibold text-nq-foreground transition-colors hover:border-nq-primary/40 hover:text-nq-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45 [&::-webkit-details-marker]:hidden"
        >
          <CalendarDays className="h-4 w-4 text-nq-primary" aria-hidden />
          <span className="hidden sm:inline">{calendarLabel}</span>
          <span className="text-nq-primary">{labels[value]}</span>
          <ChevronDown
            className="h-3.5 w-3.5 text-nq-muted transition-transform group-open:rotate-180"
            aria-hidden
          />
        </summary>
        <div
          data-testid="shell-v2-calendar-view-menu"
          className="absolute left-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-2xl border border-nq-border bg-nq-surface p-1.5 shadow-xl"
        >
          {MODES.map((mode) => {
            const active = value === mode;
            return (
              <button
                key={mode}
                type="button"
                data-testid={`shell-v2-calendar-menu-${mode}`}
                aria-current={active ? "page" : undefined}
                onClick={(event) => {
                  onChange(mode);
                  event.currentTarget
                    .closest("details")
                    ?.removeAttribute("open");
                }}
                className={cn(
                  "flex min-h-11 w-full items-center rounded-xl px-3 text-left text-sm font-semibold transition-colors",
                  active
                    ? "bg-nq-primary/15 text-nq-primary"
                    : "text-nq-muted hover:bg-nq-bg hover:text-nq-foreground",
                )}
              >
                {labels[mode]}
              </button>
            );
          })}
        </div>
      </details>
    </>
  );
}
