"use client";

import { cn } from "@/shared/lib/cn";

// Display range: 7:00 AM to 9:00 PM
const RANGE_START = 420; // 7am in minutes
const RANGE_END = 1260; // 9pm in minutes
const RANGE = RANGE_END - RANGE_START; // 840 minutes total

function hmToMins(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

interface HoursBarProps {
  /** "HH:MM" format e.g. "09:00" */
  open: string;
  /** "HH:MM" format e.g. "19:00" */
  close: string;
  /** When true, render as closed (no fill, muted appearance) */
  closed: boolean;
  /** When true, use gold/warning accent (day is overriding the master schedule) */
  isOverride?: boolean;
  className?: string;
}

export function HoursBar({
  open,
  close,
  closed,
  isOverride = false,
  className,
}: HoursBarProps) {
  if (closed) {
    return (
      <div
        className={cn(
          "relative h-1.5 w-full overflow-hidden rounded-full bg-nq-muted/10",
          className,
        )}
      />
    );
  }

  const openMin = Math.max(RANGE_START, Math.min(RANGE_END, hmToMins(open)));
  const closeMin = Math.max(RANGE_START, Math.min(RANGE_END, hmToMins(close)));

  const leftPct = ((openMin - RANGE_START) / RANGE) * 100;
  const widthPct = Math.max(0, ((closeMin - openMin) / RANGE) * 100);

  return (
    <div
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-nq-muted/15",
        className,
      )}
    >
      <div
        className={cn(
          "absolute inset-y-0 rounded-full transition-all duration-200",
          isOverride ? "bg-nq-warning/60" : "bg-nq-primary/50",
        )}
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      />
    </div>
  );
}
