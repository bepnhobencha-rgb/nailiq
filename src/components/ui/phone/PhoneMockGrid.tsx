import { type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

type PhoneMockGridProps = {
  strip: readonly [string, string, string];
  times: readonly [string, string, string];
  col: number;
  timeLit: boolean;
  bottom: ReactNode;
};

/**
 * In-phone two-row service + time selector with optional booking card.
 */
export function PhoneMockGrid({
  strip,
  times,
  col,
  timeLit,
  bottom,
}: PhoneMockGridProps) {
  const iSel = col % 3;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5" aria-hidden>
        <div className="flex justify-center gap-1">
          {strip.map((name, i) => {
            const on = i === iSel;
            return (
              <span
                key={name}
                className={cn(
                  "rounded-lg px-2 py-1 text-[10px] font-medium tracking-wide transition-all duration-300 ease-out",
                  on
                    ? "bg-nq-primary/[0.12] text-nq-primary shadow-sm ring-1 ring-nq-primary/20"
                    : "text-nq-muted/75",
                )}
              >
                {name}
              </span>
            );
          })}
        </div>
        <div className="flex justify-center gap-1">
          {times.map((t, i) => {
            const on = timeLit && i === iSel;
            return (
              <span
                key={t}
                className={cn(
                  "rounded-lg px-2 py-0.5 text-[9px] font-medium tabular-nums tracking-wide transition-all duration-300 ease-out",
                  on
                    ? "bg-nq-surface/90 text-nq-foreground/95 ring-1 ring-nq-border/50"
                    : "text-nq-muted/60",
                )}
              >
                {t}
              </span>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1" aria-hidden />
      <div className="mt-1 flex min-h-0 shrink-0 flex-col gap-1.5">{bottom}</div>
    </div>
  );
}
