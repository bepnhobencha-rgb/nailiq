"use client";

import { useEffect, useState } from "react";
import { cn } from "@/shared/lib/cn";

type IphoneStatusBarProps = {
  className?: string;
  /**
   * When `live`, shows current local time; otherwise a static string (e.g. “9:41”).
   * With reduced motion, uses static to avoid re-renders.
   */
  mode: "live" | "static";
  staticLabel: string;
};

/**
 * iOS-style status row: time, signal, Wi-Fi slot, battery. Token-only colors.
 */
export function IphoneStatusBar({
  className,
  mode,
  staticLabel,
}: IphoneStatusBarProps) {
  const [time, setTime] = useState(() => formatTime());

  useEffect(() => {
    if (mode !== "live") {
      return;
    }
    const t1 = window.setTimeout(() => setTime(formatTime()), 0);
    const t2 = window.setInterval(() => setTime(formatTime()), 60_000);
    return () => {
      clearTimeout(t1);
      clearInterval(t2);
    };
  }, [mode]);

  const label = mode === "live" ? time : staticLabel;

  return (
    <div
      className={cn(
        "flex h-7 w-full shrink-0 items-end justify-between px-3.5 pb-0.5 pt-0.5",
        className,
      )}
    >
      <p className="pl-1 text-[11px] font-semibold tabular-nums leading-none tracking-tight text-nq-foreground">
        {label}
      </p>
      <div className="flex items-end gap-1.5 pr-0.5 text-nq-foreground" aria-hidden>
        <div className="mb-0.5 flex h-2.5 items-end justify-end gap-px">
          <span className="w-0.5 rounded-sm bg-nq-foreground" style={{ height: 4 }} />
          <span className="w-0.5 rounded-sm bg-nq-foreground" style={{ height: 6 }} />
          <span className="w-0.5 rounded-sm bg-nq-foreground" style={{ height: 8 }} />
          <span className="w-0.5 rounded-sm bg-nq-foreground" style={{ height: 10 }} />
        </div>
        <div className="mb-0.5 h-2.5 w-3.5 rounded-[3px] border border-nq-foreground/90">
          <div
            className="m-px h-1.5 w-[60%] rounded-[1.5px] bg-nq-primary/95"
            style={{ marginTop: 2, marginLeft: 2 }}
          />
        </div>
      </div>
    </div>
  );
}

function formatTime() {
  return new Date().toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
