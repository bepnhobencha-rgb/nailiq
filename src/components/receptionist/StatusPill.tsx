"use client";

import { cn } from "@/shared/lib/cn";

export interface StatusPillProps {
  waitingCount: number;
  inProgressCount: number;
  labelWaiting: string;
  labelInProgress: string;
}

type PillState = "calm" | "default" | "busy";

function deriveState(waitingCount: number, inProgressCount: number): PillState {
  const totalActive = waitingCount + inProgressCount;
  if (totalActive >= 6 || waitingCount >= 4) return "busy";
  if (totalActive <= 2) return "calm";
  return "default";
}

export function StatusPill({
  waitingCount,
  inProgressCount,
  labelWaiting,
  labelInProgress,
}: StatusPillProps) {
  const pillState = deriveState(waitingCount, inProgressCount);

  return (
    <div
      data-testid="status-pill"
      data-state={pillState}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.12em]",
        pillState === "calm" &&
          "border border-nq-success/55 bg-nq-success/15 text-nq-success",
        pillState === "default" &&
          "border border-nq-border/80 bg-nq-surface text-nq-muted",
        pillState === "busy" &&
          "border border-nq-warning/60 bg-nq-warning/25 text-nq-foreground",
      )}
      role="status"
      aria-live="polite"
    >
      {pillState === "busy" && (
        <span
          className="inline-flex h-2 w-2 shrink-0 rounded-full bg-nq-warning motion-safe:animate-pulse"
          aria-hidden
        />
      )}
      <span className="tabular-nums">
        {waitingCount} {labelWaiting} · {inProgressCount} {labelInProgress}
      </span>
    </div>
  );
}
