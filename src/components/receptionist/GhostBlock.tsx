"use client";

import { cn } from "@/shared/lib/cn";

export interface GhostBlockProps {
  leftPx: number;
  widthPx: number;
  state: "ok" | "conflict" | "overflow";
  /** True when the start locked flush onto a preceding booking's end
   *  (back-to-back). Shows a distinct emerald "snapped" treatment. */
  flush?: boolean;
  label: string;
}

export function GhostBlock({
  leftPx,
  widthPx,
  state,
  flush = false,
  label,
}: GhostBlockProps) {
  const ok = state === "ok";

  return (
    <div
      data-testid="ghost-block"
      data-state={state}
      data-flush={flush ? "true" : undefined}
      className={cn(
        "pointer-events-none absolute top-1.5 bottom-1.5 z-30 flex items-center justify-center rounded-lg border-2 px-2",
        // Springy snap into place + a soft pulse so the moving block reads as
        // "alive" rather than a static outline.
        "transition-[left,width] duration-150 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-safe:animate-pulse",
        flush
          ? // Locked flush: solid emerald, glowing ring → "perfect back-to-back".
            "border-emerald-400 bg-emerald-400/25 text-emerald-100 shadow-[0_0_0_2px_rgba(16,185,129,0.35),0_8px_24px_-4px_rgba(16,185,129,0.55)]"
          : ok
            ? // Normal move: dashed gold with a premium glow.
              "border-dashed border-nq-primary bg-nq-primary/[0.18] text-nq-primary shadow-[0_0_0_1px_rgba(212,175,55,0.25),0_8px_22px_-6px_rgba(212,175,55,0.5)]"
            : "border-dashed border-nq-error bg-nq-error/[0.2] text-nq-error shadow-[0_0_0_1px_rgba(239,68,68,0.3)]",
      )}
      style={{
        left: leftPx,
        width: Math.max(0, widthPx - 4),
      }}
    >
      <span className="truncate px-1 text-center font-mono text-sm font-semibold leading-tight drop-shadow">
        {label}
      </span>
    </div>
  );
}
