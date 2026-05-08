import { type ReactNode } from "react";

import { cn } from "@/shared/lib/cn";
import { Card } from "@/components/ui/Card";

export type KPITrend = "up" | "down" | "neutral";
export type KPIStatus = "default" | "warning" | "danger";

const valueColors: Record<KPIStatus, string> = {
  default: "text-nq-foreground",
  warning: "text-nq-warning",
  danger: "text-nq-error",
};

const trendColors: Record<KPITrend, string> = {
  up: "text-nq-success",
  down: "text-nq-error",
  neutral: "text-nq-muted",
};

function TrendIcon({ trend }: { trend: KPITrend }) {
  const common = {
    viewBox: "0 0 16 16",
    width: 12,
    height: 12,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (trend === "up") {
    return (
      <svg {...common}>
        <path d="M3 11l5-5 5 5" />
      </svg>
    );
  }
  if (trend === "down") {
    return (
      <svg {...common}>
        <path d="M3 5l5 5 5-5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M3 8h10" />
    </svg>
  );
}

export type KPIWidgetProps = {
  label: string;
  value: string | number;
  trend?: KPITrend;
  trendValue?: string;
  status?: KPIStatus;
  isLoading?: boolean;
  icon?: ReactNode;
  className?: string;
};

export function KPIWidget({
  label,
  value,
  trend,
  trendValue,
  status = "default",
  isLoading = false,
  icon,
  className,
}: KPIWidgetProps) {
  if (isLoading) {
    return (
      <Card variant="elevated" padding="md" className={className}>
        <div className="flex items-start gap-3">
          {icon ? (
            <div
              className="h-6 w-6 shrink-0 rounded-md bg-nq-border/60"
              aria-hidden
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div
              className="h-3 w-20 rounded bg-nq-border/60"
              aria-hidden
            />
            <div
              className="h-7 w-24 rounded bg-nq-border/60"
              aria-hidden
            />
            <div
              className="h-3 w-16 rounded bg-nq-border/40"
              aria-hidden
            />
          </div>
        </div>
        <span className="sr-only">Loading {label}</span>
      </Card>
    );
  }

  const showTrendRow = trend !== undefined || trendValue !== undefined;
  const trendColor = trend ? trendColors[trend] : "text-nq-muted";

  return (
    <Card variant="elevated" padding="md" className={className}>
      <div className="flex items-start gap-3">
        {icon ? (
          <div className="shrink-0 text-nq-muted" aria-hidden>
            {icon}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="text-xs font-medium uppercase tracking-wide text-nq-muted">
            {label}
          </div>
          <div
            className={cn(
              "text-2xl font-semibold leading-tight tabular-nums",
              valueColors[status],
            )}
          >
            {value}
          </div>
          {showTrendRow ? (
            <div
              className={cn(
                "inline-flex items-center gap-1 text-xs",
                trendColor,
              )}
            >
              {trend ? <TrendIcon trend={trend} /> : null}
              {trendValue ? <span>{trendValue}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export default KPIWidget;
