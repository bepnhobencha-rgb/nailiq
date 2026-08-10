"use client";

import { cn } from "@/shared/lib/cn";

export interface DateSwitcherProps {
  /** Current selected offset from today; null for any other calendar day. */
  selectedOffset: -1 | 0 | 1 | null;
  /** Localized labels */
  labels: {
    yesterday: string;
    today: string;
    tomorrow: string;
  };
  onChange: (offset: -1 | 0 | 1) => void;
}

const OFFSETS = [-1, 0, 1] as const;

export function DateSwitcher({ selectedOffset, labels, onChange }: DateSwitcherProps) {
  const labelMap: Record<-1 | 0 | 1, string> = {
    [-1]: labels.yesterday,
    [0]: labels.today,
    [1]: labels.tomorrow,
  };

  return (
    <div
      className={cn(
        "inline-flex rounded-full border border-nq-muted/35 bg-nq-surface p-0.5",
      )}
      role="tablist"
      aria-label="Day"
    >
      {OFFSETS.map((offset) => {
        const active = selectedOffset === offset;
        return (
          <button
            key={offset}
            type="button"
            role="tab"
            data-testid={
              offset === -1
                ? "date-switcher-yesterday"
                : offset === 0
                  ? "date-switcher-today"
                  : "date-switcher-tomorrow"
            }
            aria-selected={active}
            className={cn(
              "min-h-11 min-w-[4.5rem] shrink-0 rounded-full px-3 py-2 text-base font-medium transition-[color,background-color,transform] duration-[var(--duration-nq-fast,150ms)] ease-out active:scale-[0.98] motion-reduce:active:scale-100",
              active
                ? "bg-nq-primary/18 text-nq-primary shadow-none"
                : "bg-transparent text-nq-muted hover:text-nq-foreground",
            )}
            onClick={() => onChange(offset)}
          >
            {labelMap[offset]}
          </button>
        );
      })}
    </div>
  );
}
