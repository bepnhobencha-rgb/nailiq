"use client";

import { type HTMLAttributes, type ReactNode, useEffect, useState } from "react";
import { cn } from "@/shared/lib/cn";

const DEFAULT_SERVICE_STRIP = ["Pedicure", "Gel", "Manicure"] as const;

export type PhoneFrameProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** "Preview" text shown in the status area when no child banner */
  statusLabel?: string;
  /** Rotating one-line service labels; booking UI defaults to English */
  serviceStrip?: readonly [string, string, string];
};

/**
 * iPhone-style device chrome for marketing or feature previews. Inner content
 * is the “screen” area; service label rotates on a 2.5s interval with
 * one-shot `fade-in` and cleanup on unmount. Ambient gold glows are pure CSS
 * (no animation libraries).
 */
export function PhoneFrame({
  className,
  children,
  statusLabel = "9:41",
  serviceStrip = DEFAULT_SERVICE_STRIP,
  ...props
}: PhoneFrameProps) {
  const [index, setIndex] = useState(0);
  const strip = serviceStrip;

  useEffect(() => {
    const preferReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    if (preferReduced.matches) return;

    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % strip.length);
    }, 2400);
    return () => clearInterval(id);
  }, [strip]);

  return (
    <div
      className={cn("relative mx-auto w-full max-w-[17.5rem] py-2", className)}
      {...props}
    >
      <div
        className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-56 w-56 -translate-x-1/2 -translate-y-1/2"
        aria-hidden
      >
        <div
          className="h-full w-full rounded-full bg-nq-primary/25 blur-[48px] animate-nq-orb"
        />
      </div>
      <div
        className="pointer-events-none absolute top-1/2 left-1/2 -z-20 h-72 w-72 -translate-x-1/2 -translate-y-1/2"
        aria-hidden
      >
        <div
          className="h-full w-full rounded-full bg-nq-primary/10 blur-[80px] opacity-90"
        />
      </div>
      <div
        className={cn(
          "relative aspect-[9/19.5] w-full touch-manipulation select-none",
          "rounded-[2.4rem] border border-nq-border/80 p-1.5",
          "bg-gradient-to-b from-nq-surface to-nq-bg shadow-nq-card",
          "origin-center transition-transform duration-300 will-change-transform",
          "active:scale-[0.99]",
        )}
      >
        <div
          className="relative h-full w-full overflow-hidden rounded-[1.85rem] border border-nq-border/50 bg-nq-bg"
        >
          <div className="absolute top-0 right-0 left-0 z-10 flex h-7 items-end justify-center pb-0.5">
            <div
              className="h-4 w-24 rounded-b-xl bg-nq-surface/95 ring-1 ring-nq-border/50"
            />
          </div>
          <div className="px-2 pt-8 pb-2 text-center text-[10px] font-medium tabular-nums tracking-wide text-nq-muted">
            {statusLabel}
          </div>
          <div className="h-[calc(100%-3.4rem)] min-h-0 overflow-hidden px-1.5 pb-2 sm:px-2">
            <div
              className="h-full min-h-0 overflow-hidden rounded-2xl border border-nq-border/30 bg-nq-surface/40 p-2"
            >
              <div className="flex h-full min-h-0 flex-col">
                <div
                  className="relative mt-0.5 h-5 shrink-0 overflow-hidden text-center"
                  aria-hidden
                >
                  <div
                    key={`hi-${index}`}
                    className="fade-in pointer-events-none absolute inset-0 -mx-0.5 -my-px rounded-md bg-nq-primary/[0.08] ring-1 ring-nq-primary/10"
                    aria-hidden
                  />
                  <p
                    key={index}
                    className="fade-in relative z-10 flex h-5 items-center justify-center text-[11px] font-semibold tracking-wide text-nq-primary"
                  >
                    {strip[index]}
                  </p>
                </div>
                <div
                  className="animate-nq-content-pulse min-h-0 flex-1 pt-2.5 will-change-[opacity]"
                >
                  {children}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
