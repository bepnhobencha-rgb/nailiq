"use client";

import { useEffect } from "react";

import { cn } from "@/shared/lib/cn";

export interface UndoToastProps {
  open: boolean;
  message: string;
  detail: string;
  /** When false (6c-1): parent timer handles dismiss; no frozen “Ns” chip. Enable in 6c-2 when seconds tick. */
  showCountdown?: boolean;
  secondsRemaining: number;
  labelUndo: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export function UndoToast({
  open,
  message,
  detail,
  showCountdown = false,
  secondsRemaining,
  labelUndo,
  onUndo,
  onDismiss,
}: UndoToastProps) {
  useEffect(() => {
    if (!showCountdown || !open || secondsRemaining > 0) return;
    onDismiss();
  }, [showCountdown, open, secondsRemaining, onDismiss]);

  return (
    <div
      data-testid="undo-toast"
      className={cn(
        "fixed bottom-6 left-1/2 z-50 flex max-w-[min(100vw-2rem,28rem)] -translate-x-1/2 px-4",
        "motion-safe:transition-[transform,opacity] motion-safe:duration-300 motion-safe:ease-[var(--ease-nq-out,cubic-bezier(0.22,1,0.36,1))]",
        open
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-3 opacity-0",
      )}
      aria-live="polite"
      aria-hidden={!open}
      inert={!open}
    >
      <div
        className={cn(
          "flex w-full items-start gap-3 rounded-xl border-2 border-nq-primary bg-nq-surface p-4 shadow-nq-card",
        )}
      >
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-nq-success text-sm font-semibold leading-none text-nq-foreground"
          aria-hidden
        >
          ✓
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-sm font-semibold leading-snug text-nq-foreground">
            {message}
          </p>
          <p className="mt-1 font-mono text-xs text-nq-muted">{detail}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            data-testid="undo-toast-undo"
            className={cn(
              "min-h-11 min-w-11 rounded-lg border border-nq-primary/50 bg-nq-primary/15 px-3 text-sm font-semibold text-nq-primary",
              "transition-opacity duration-[var(--duration-nq-fast,150ms)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-surface",
            )}
            onClick={() => {
              onUndo();
              onDismiss();
            }}
          >
            {labelUndo}
          </button>
          {showCountdown ? (
            <span className="font-mono text-[11px] tabular-nums text-nq-muted">
              {secondsRemaining}s
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
