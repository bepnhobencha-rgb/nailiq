"use client";

import { cn } from "@/shared/lib/cn";

export interface GhostBlockProps {
  leftPx: number;
  widthPx: number;
  state: "ok" | "conflict" | "overflow";
  label: string;
}

export function GhostBlock({ leftPx, widthPx, state, label }: GhostBlockProps) {
  const ok = state === "ok";

  return (
    <div
      data-testid="ghost-block"
      data-state={state}
      className={cn(
        "pointer-events-none absolute top-1.5 bottom-1.5 flex items-center justify-center rounded-lg border-2 border-dashed px-2 transition-[left,width] duration-100 ease-out",
        ok
          ? "border-nq-primary bg-nq-primary/[0.18] text-nq-primary"
          : "border-nq-error bg-nq-error/[0.18] text-nq-error",
      )}
      style={{
        left: leftPx,
        width: Math.max(0, widthPx - 4),
      }}
    >
      <span className="px-1 text-center font-mono text-sm font-semibold leading-tight">
        {label}
      </span>
    </div>
  );
}
