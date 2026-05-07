"use client";

import { cn } from "@/shared/lib/cn";

export interface NowLineProps {
  leftPx: number | null;
  nowLabel: string;
}

/**
 * Vertical "current time" marker across staff rows (horizontal timeline).
 * Spans full row stack; color uses brand primary (gold).
 */
export function NowLine({ leftPx, nowLabel }: NowLineProps) {
  if (leftPx === null) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 flex -translate-x-1/2 flex-col items-center",
      )}
      style={{ left: leftPx }}
      aria-hidden
    >
      <span
        className={cn(
          "mb-0.5 rounded border border-nq-primary/45 bg-nq-bg/92 px-1 py-0.5 font-mono text-[9px] font-medium tabular-nums text-nq-primary",
        )}
      >
        {nowLabel}
      </span>
      <div
        className="min-h-0 w-px flex-1 shrink"
        style={{
          backgroundColor: "var(--color-nq-primary)",
          boxShadow:
            "0 0 8px color-mix(in srgb, var(--color-nq-primary) 40%, transparent)",
        }}
      />
    </div>
  );
}
