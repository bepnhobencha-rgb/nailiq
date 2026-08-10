"use client";

import { cn } from "@/shared/lib/cn";

/**
 * The clear "which day am I looking at" anchor for the Front Desk Day view.
 * A premium calendar tear-off tile (gold when it's today) + weekday + full
 * date, localized. Critical when you drill into an arbitrary day from Month
 * view — the Yesterday/Today/Tomorrow tabs alone can't tell you the date.
 *
 * Fixed `vi-VN` / `en-US` locale on a plain calendar date (no UTC instant)
 * keeps the format identical server + client — hydration-safe.
 */
function ymdToDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function ViewedDateChip({
  ymd,
  language,
  isToday,
}: {
  ymd: string;
  language: "en" | "vi";
  isToday: boolean;
}) {
  const date = ymdToDate(ymd);
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  const monthShort = new Intl.DateTimeFormat(locale, { month: "short" })
    .format(date)
    .replace(/\.$/, "");
  const full = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
  return (
    <div className="flex shrink-0 items-center gap-2.5" data-testid="viewed-date-chip">
      {/* Calendar tear-off tile */}
      <div
        className={cn(
          "flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl border leading-none transition-colors",
          isToday
            ? "border-nq-primary/55 bg-nq-primary/15 text-nq-primary shadow-nq-glow"
            : "border-nq-border/60 bg-nq-surface/60 text-nq-foreground",
        )}
      >
        <span className="text-[8px] font-semibold uppercase tracking-wide opacity-70">
          {monthShort}
        </span>
        <span className="text-lg font-bold tabular-nums leading-none">
          {date.getDate()}
        </span>
      </div>
      {/* Weekday + full date */}
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-semibold capitalize text-nq-foreground">
          <span className="truncate">{weekday}</span>
        </p>
        <p className="truncate text-xs text-nq-muted">{full}</p>
      </div>
    </div>
  );
}
