"use client";

import { cn } from "@/shared/lib/cn";

export interface NowLineProps {
  leftPx: number | null;
  nowLabel: string;
}

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
      <div className={cn("relative flex flex-col items-center")}>
        <span
          className={cn(
            "mb-1 rounded-md border border-nq-error bg-nq-bg/95 px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums tracking-wide text-nq-error",
          )}
        >
          {nowLabel}
        </span>
        <div
          className="relative h-3 w-3 shrink-0 rounded-full bg-nq-error"
          style={{
            boxShadow:
              "0 0 8px color-mix(in srgb, var(--color-nq-error) 60%, transparent)",
          }}
        />
      </div>

      <div
        className="min-h-0 w-0.5 flex-1 shrink bg-nq-error"
        style={{
          boxShadow:
            "0 0 8px color-mix(in srgb, var(--color-nq-error) 60%, transparent)",
        }}
      />
    </div>
  );
}
