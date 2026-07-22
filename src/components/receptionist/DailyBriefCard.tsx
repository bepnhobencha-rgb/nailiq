"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Sparkles, X } from "lucide-react";

import { cn } from "@/shared/lib/cn";

type BriefBooking = {
  status: string;
  start_time_utc: string;
  end_time_utc: string;
  is_vip: boolean;
  no_show_risk_score: number | null;
};

type Labels = {
  eyebrow: string;
  title: string;
  bookings: string;
  vip: string;
  staffReady: string;
  waiting: string;
  dayWindow: (start: string, end: string) => string;
  riskGuests: (count: number) => string;
  calmDay: string;
  collapse: string;
  expand: string;
};

type Props = {
  slug: string;
  selectedDate: string;
  bookings: BriefBooking[];
  readyStaffCount: number;
  totalStaffCount: number;
  waitingCount: number;
  formatTime: (utcIso: string) => string;
  labels: Labels;
};

const ACTIVE_STATUSES = new Set(["pending", "confirmed", "in_progress", "completed"]);
const HIGH_RISK_SCORE = 60;

/** A 10-second start-of-day briefing that remembers when it was reviewed. */
export function DailyBriefCard({
  slug,
  selectedDate,
  bookings,
  readyStaffCount,
  totalStaffCount,
  waitingCount,
  formatTime,
  labels,
}: Props) {
  const storageKey = `nailiq-daily-brief-seen:${slug}:${selectedDate}`;
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        setExpanded(window.localStorage.getItem(storageKey) !== "1");
      } catch {
        // Storage can be unavailable in private mode; the briefing remains open.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [storageKey]);

  const summary = useMemo(() => {
    const active = bookings
      .filter((booking) => ACTIVE_STATUSES.has(booking.status))
      .sort((a, b) => a.start_time_utc.localeCompare(b.start_time_utc));
    return {
      count: active.length,
      vipCount: active.filter((booking) => booking.is_vip).length,
      riskCount: active.filter(
        (booking) => (booking.no_show_risk_score ?? 0) >= HIGH_RISK_SCORE,
      ).length,
      first: active[0]?.start_time_utc ?? null,
      last: active.at(-1)?.end_time_utc ?? null,
    };
  }, [bookings]);

  const collapse = () => {
    setExpanded(false);
    try {
      window.localStorage.setItem(storageKey, "1");
    } catch {
      // Keeping the UI responsive matters more than persistence.
    }
  };

  if (!expanded) {
    return (
      <div className="border-b border-nq-muted/20 px-[var(--pad-nq-section-mobile)] py-1.5 md:px-6">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mx-auto flex min-h-9 w-full max-w-[var(--max-nq-desktop)] items-center gap-2 rounded-lg px-2 text-left text-xs text-nq-muted transition-colors hover:bg-nq-surface/70 hover:text-nq-foreground"
          aria-label={labels.expand}
        >
          <Sparkles className="h-4 w-4 text-nq-primary" aria-hidden />
          <span className="font-semibold text-nq-foreground">{labels.title}</span>
          <span className="truncate">· {summary.count} {labels.bookings.toLocaleLowerCase()}</span>
          <ChevronDown className="ml-auto h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <section
      data-testid="nailiq-daily-brief"
      className="border-b border-nq-muted/20 px-[var(--pad-nq-section-mobile)] py-2.5 md:px-6"
    >
      <div className="mx-auto w-full max-w-[var(--max-nq-desktop)] rounded-2xl border border-nq-primary/25 bg-gradient-to-br from-nq-primary/[0.11] to-nq-surface/70 p-3 shadow-sm sm:p-4">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-nq-primary text-nq-bg shadow-sm">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-nq-primary">
              {labels.eyebrow}
            </p>
            <h2 className="text-base font-semibold text-nq-foreground sm:text-lg">
              {labels.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={collapse}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-nq-muted transition-colors hover:bg-nq-surface hover:text-nq-foreground"
            aria-label={labels.collapse}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-4 gap-2">
          <Metric value={summary.count} label={labels.bookings} />
          <Metric value={summary.vipCount} label={labels.vip} />
          <Metric value={`${readyStaffCount}/${totalStaffCount}`} label={labels.staffReady} />
          <Metric value={waitingCount} label={labels.waiting} />
        </div>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-nq-muted">
          {summary.first && summary.last ? (
            <p>{labels.dayWindow(formatTime(summary.first), formatTime(summary.last))}</p>
          ) : null}
          <p
            className={cn(
              summary.riskCount > 0 ? "font-medium text-nq-warning" : "",
            )}
          >
            {summary.riskCount > 0
              ? labels.riskGuests(summary.riskCount)
              : labels.calmDay}
          </p>
        </div>
      </div>
    </section>
  );
}

function Metric({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.06] bg-nq-bg/35 px-2 py-2 text-center">
      <p className="text-lg font-semibold tabular-nums text-nq-foreground">{value}</p>
      <p className="truncate text-[10px] text-nq-muted sm:text-xs">{label}</p>
    </div>
  );
}
