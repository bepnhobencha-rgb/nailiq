import { type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Card } from "@/components/ui/Card";

type Accent = "gold" | "blue" | "green";

const accentRing: Record<Accent, string> = {
  gold: "ring-1 ring-nq-primary/20",
  blue: "ring-1 ring-nq-info/20",
  green: "ring-1 ring-nq-success/20",
};

const accentValue: Record<Accent, string> = {
  gold: "text-nq-primary",
  blue: "text-nq-info",
  green: "text-nq-success",
};

const accentIconWrap: Record<Accent, string> = {
  gold: "bg-nq-primary/12 text-nq-primary",
  blue: "bg-nq-info/12 text-nq-info",
  green: "bg-nq-success/12 text-nq-success",
};

/**
 * Compact KPI tile for the owner dashboard "Today" summary. Built on the
 * shared Card so it matches the Reports KPIWidget surface, with an
 * optional accent-tinted icon chip and uppercase label. Accent drives the
 * value colour + icon tint (gold/blue/green) so the row stays glanceable;
 * no accent keeps a calm neutral tile per brand restraint.
 */
export function SalonOwnerStatPill({
  label,
  value,
  accent,
  icon,
  className,
}: {
  label: string;
  value: string;
  accent?: Accent;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Card
      variant="elevated"
      padding="sm"
      className={cn(accent ? accentRing[accent] : undefined, className)}
    >
      <div className="flex items-start gap-2.5">
        {icon ? (
          <span
            aria-hidden
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
              accent ? accentIconWrap[accent] : "bg-nq-border/40 text-nq-muted",
            )}
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-nq-muted">
            {label}
          </p>
          <p
            className={cn(
              "mt-0.5 text-2xl font-semibold leading-tight tabular-nums",
              accent ? accentValue[accent] : "text-nq-foreground",
            )}
          >
            {value}
          </p>
        </div>
      </div>
    </Card>
  );
}
