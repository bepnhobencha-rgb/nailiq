"use client";

import { type ReactNode } from "react";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import {
  QueueChip,
  type QueueSourceVariant,
} from "@/components/ui/QueueChip";
import { cn } from "@/shared/lib/cn";
import type {
  QueuePriority,
  QueueRequestTag,
  QueueSource,
} from "@/shared/types";

const WAIT_WARNING_MIN = 10;
const WAIT_DANGER_MIN = 20;

/**
 * Maps the wire-format `QueueSource` (`walk_in` underscore) onto the
 * `QueueChip` display variant (`walk-in` hyphen). Centralized so the
 * underscore-vs-hyphen drift between the data model and the UI primitive
 * is hidden from callers.
 */
function queueSourceToChipVariant(source: QueueSource): QueueSourceVariant {
  if (source === "walk_in") return "walk-in";
  return source;
}

const priorityVariant: Record<
  QueuePriority,
  "danger" | "warning" | "neutral"
> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

function waitColorClass(minutes: number): string {
  if (minutes >= WAIT_DANGER_MIN) return "text-nq-error";
  if (minutes >= WAIT_WARNING_MIN) return "text-nq-warning";
  return "text-nq-muted";
}

export type QueueEntryCardProps = {
  /** Position number rendered as `1`, `2`, etc. */
  position: number;
  customerName: string;
  serviceName: string;
  /** Total wait time in minutes; rendered with a color step at 10 / 20 min. */
  waitMinutes: number;
  /** Optional total slot span hint shown next to the service name. */
  serviceDurationMinutes?: number;
  source?: QueueSource | null;
  priority?: QueuePriority | null;
  requestTags?: ReadonlyArray<QueueRequestTag>;
  partySize?: number | null;
  /** When false, hides wait time + urgency colour entirely. */
  showWaitTime?: boolean;
  /** When false, suppresses the VIP source chip (other sources still render). */
  showVipIndicator?: boolean;
  /** Localized strings (no fallback copy). */
  labels: {
    minutesAgo: (n: number) => string;
    priorityHigh: string;
    priorityMedium: string;
    priorityLow: string;
    partySizeLabel: (n: number) => string;
    sourceFallback: string;
  };
  /** Highlighted treatment when this row is the active assign target. */
  isAssigning?: boolean;
  className?: string;
  /** Footer slot — typically Cancel / Assign action buttons. */
  actions?: ReactNode;
};

export function QueueEntryCard({
  position,
  customerName,
  serviceName,
  waitMinutes,
  serviceDurationMinutes,
  source,
  priority,
  requestTags,
  partySize,
  showWaitTime = true,
  showVipIndicator = true,
  labels,
  isAssigning = false,
  className,
  actions,
}: QueueEntryCardProps) {
  const isUrgentByWait = showWaitTime && waitMinutes >= WAIT_WARNING_MIN;
  const isDangerByWait = showWaitTime && waitMinutes >= WAIT_DANGER_MIN;
  const showSourceChip =
    source !== null &&
    source !== undefined &&
    (source !== "vip" || showVipIndicator);
  const tags = requestTags ?? [];
  const showParty = typeof partySize === "number" && partySize > 1;
  const priorityLabel: Record<QueuePriority, string> = {
    high: labels.priorityHigh,
    medium: labels.priorityMedium,
    low: labels.priorityLow,
  };

  return (
    <Card
      variant="default"
      padding="md"
      state={isAssigning ? "selected" : "static"}
      className={cn(
        isDangerByWait &&
          !isAssigning &&
          "border-nq-error/55 bg-nq-error/[0.08]",
        isUrgentByWait &&
          !isDangerByWait &&
          !isAssigning &&
          "border-nq-warning/45 bg-nq-warning/[0.08]",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-nq-bg text-xs font-semibold tabular-nums text-nq-muted ring-1 ring-inset ring-nq-border"
        >
          {position}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-nq-foreground">
              {customerName}
            </span>
            {priority ? (
              <Badge
                size="sm"
                state="default"
                variant={priorityVariant[priority]}
                aria-label={priorityLabel[priority]}
              >
                {priorityLabel[priority].toUpperCase()}
              </Badge>
            ) : null}
            {showParty ? (
              <Badge size="sm" state="subtle" variant="info">
                {labels.partySizeLabel(partySize ?? 1)}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 truncate text-xs text-nq-muted">
            {serviceName}
            {typeof serviceDurationMinutes === "number" &&
            serviceDurationMinutes > 0 ? (
              <span className="font-mono"> · {serviceDurationMinutes}m</span>
            ) : null}
          </p>

          {showWaitTime ? (
            <p
              className={cn(
                "mt-1 text-xs tabular-nums",
                waitColorClass(waitMinutes),
              )}
            >
              {labels.minutesAgo(waitMinutes)}
            </p>
          ) : null}

          {showSourceChip || tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {showSourceChip && source ? (
                <QueueChip
                  type="source"
                  variant={queueSourceToChipVariant(source)}
                  size="sm"
                  label={
                    source === "walk_in"
                      ? labels.sourceFallback
                      : source
                  }
                />
              ) : null}
              {tags.map((tag, idx) => (
                <QueueChip
                  key={`${tag}-${idx}`}
                  type="request"
                  size="sm"
                  label={tag}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {actions ? <div className="mt-3">{actions}</div> : null}
    </Card>
  );
}

export default QueueEntryCard;
