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
  /** Marks the customer as a returning VIP — drives the gold crown badge. */
  isVip?: boolean;
  /** Customer specifically asked for a particular staff. Pairs with
   * `requestedStaffName` to render the heart-line. */
  staffRequestedByClient?: boolean;
  /** Localized name of the requested staff (resolved by the parent
   * loader). When absent, the heart-line still renders if
   * `staffRequestedByClient` is set, but without a name suffix. */
  requestedStaffName?: string | null;
  /** ISO time the requested staff is projected to be free. Powers the
   * "Ready ~3:25 PM" suffix on the staff line. */
  requestedStaffReadyAtIso?: string | null;
  /** When false, hides wait time + urgency colour entirely. */
  showWaitTime?: boolean;
  /** When false, suppresses the VIP source chip (other sources still render). */
  showVipIndicator?: boolean;
  /** When true, the wait number renders +4px larger (rush hour). */
  emphasizeWait?: boolean;
  /** Soft-hold expiry — when set + > now, the card replaces the wait
   * hero with a countdown until this passes (PR #104). */
  softHoldUntilIso?: string | null;
  /** Current wall-clock — passed in so countdown ticks every minute
   * without each card mounting its own interval. */
  nowIso?: string;
  /** Localized strings (no fallback copy). */
  labels: {
    /** Hero suffix below the big wait number, e.g. "chờ" / "waiting" */
    waitHeroSuffix: string;
    priorityHigh: string;
    priorityMedium: string;
    priorityLow: string;
    partySizeLabel: (n: number) => string;
    sourceFallback: string;
    /** "👑 VIP" tooltip / aria. */
    vipAria: string;
    /** "Ready ~{time}" — interpolate {time}. */
    readyAroundShort: string;
    /** "❤️ Khách yêu cầu thợ này" — full heart-line copy. */
    requestedByClientLine: string;
    /** "Giữ chỗ: {n} phút còn lại" — interpolate {n}. */
    softHoldCountdown: (minutesLeft: number) => string;
    /** Static label rendered above the countdown. */
    softHoldLabel: string;
  };
  /** Highlighted treatment when this row is the active assign target. */
  isAssigning?: boolean;
  className?: string;
  /** Footer slot — typically Cancel / Assign action buttons. */
  actions?: ReactNode;
  /** Drag handle injected by the sortable wrapper. Renders in top-left corner. */
  dragHandle?: ReactNode;
  /** Compact mode (density=simple): position + name + service only — hides wait hero, badges, tags, and secondary actions. */
  compact?: boolean;
  /** Salon-level queue display mode. 'simple' hides priority badge, party size,
   *  staff dispatch line, heart-line, and request tags while keeping the wait hero.
   *  Defaults to 'full'. */
  displayMode?: "simple" | "full";
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
  isVip = false,
  staffRequestedByClient = false,
  requestedStaffName,
  requestedStaffReadyAtIso,
  showWaitTime = true,
  showVipIndicator = true,
  emphasizeWait = false,
  softHoldUntilIso,
  nowIso,
  labels,
  isAssigning = false,
  className,
  actions,
  dragHandle,
  compact = false,
  displayMode = "full",
}: QueueEntryCardProps) {
  const isSimple = displayMode === "simple";
  const isUrgentByWait = showWaitTime && waitMinutes >= WAIT_WARNING_MIN;
  const isDangerByWait = showWaitTime && waitMinutes >= WAIT_DANGER_MIN;
  const showSourceChip =
    source !== null &&
    source !== undefined &&
    (source !== "vip" || showVipIndicator);
  const tags = requestTags ?? [];
  const showParty = !isSimple && typeof partySize === "number" && partySize > 1;
  const priorityLabel: Record<QueuePriority, string> = {
    high: labels.priorityHigh,
    medium: labels.priorityMedium,
    low: labels.priorityLow,
  };
  const requestedStaffReadyClock = requestedStaffReadyAtIso
    ? new Date(requestedStaffReadyAtIso).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  if (compact) {
    return (
      <Card
        variant="default"
        padding="sm"
        state={isAssigning ? "selected" : "static"}
        className={cn("flex items-center gap-2 py-2", className)}
      >
        <span
          aria-hidden
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-nq-bg text-[11px] font-semibold tabular-nums text-nq-muted ring-1 ring-inset ring-nq-border"
        >
          {position}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-nq-foreground">{customerName}</p>
          <p className="truncate text-[11px] text-nq-muted">{serviceName}</p>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </Card>
    );
  }

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
        isVip && !isAssigning && "ring-1 ring-amber-300/40",
        className,
      )}
    >
      {dragHandle}
      {/* Top row: position · name · VIP crown */}
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-nq-bg text-xs font-semibold tabular-nums text-nq-muted ring-1 ring-inset ring-nq-border"
        >
          #{position}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-nq-foreground">
              {customerName}
            </span>
            {priority && !isSimple ? (
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
        </div>
        {isVip ? (
          <span
            aria-label={labels.vipAria}
            title={labels.vipAria}
            data-testid="queue-vip-crown"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-base text-amber-700 ring-1 ring-inset ring-amber-300/45"
          >
            <span aria-hidden>👑</span>
          </span>
        ) : null}
      </div>

      {/* Hero wait number — the dispatch-board centerpiece. */}
      {showWaitTime ? (() => {
        // eslint-disable-next-line react-hooks/purity -- ARCHITECTURE_LOCK: Date.now() fallback is intentional; nowIso is preferred but may be absent
        const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
        const holdMs = softHoldUntilIso ? Date.parse(softHoldUntilIso) : NaN;
        const isHeld = Number.isFinite(holdMs) && holdMs > nowMs;
        if (isHeld) {
          const minutesLeft = Math.max(
            0,
            Math.ceil((holdMs - nowMs) / 60_000),
          );
          return (
            <div
              data-testid="queue-soft-hold-hero"
              className="mt-2 rounded-md border border-amber-500/55 bg-amber-400/10 px-2.5 py-2 text-center"
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                ⏸ {labels.softHoldLabel}
              </p>
              <p className="mt-1 font-mono text-2xl font-bold leading-none tabular-nums text-amber-700">
                {labels.softHoldCountdown(minutesLeft)}
              </p>
              <p className="mt-1 truncate text-[11px] uppercase tracking-wide text-nq-muted">
                {serviceName}
              </p>
            </div>
          );
        }
        return (
          <div data-testid="queue-wait-hero" className="mt-2 text-center">
            <p
              className={cn(
                "font-mono font-bold leading-none tabular-nums",
                emphasizeWait ? "text-4xl" : "text-3xl",
                waitColorClass(waitMinutes),
              )}
            >
              {waitMinutes}
              <span
                className={cn(
                  "ml-1 font-semibold",
                  emphasizeWait ? "text-lg" : "text-base",
                )}
              >
                min
              </span>
            </p>
            <p className="mt-1 truncate text-[11px] uppercase tracking-wide text-nq-muted">
              {labels.waitHeroSuffix} · {serviceName}
              {typeof serviceDurationMinutes === "number" &&
              serviceDurationMinutes > 0 ? (
                <span className="font-mono"> · {serviceDurationMinutes}m</span>
              ) : null}
            </p>
          </div>
        );
      })() : (
        <p className="mt-2 truncate text-xs text-nq-muted">
          {serviceName}
          {typeof serviceDurationMinutes === "number" &&
          serviceDurationMinutes > 0 ? (
            <span className="font-mono"> · {serviceDurationMinutes}m</span>
          ) : null}
        </p>
      )}

      {/* Staff dispatch line: name + ready-around. Hidden in simple mode. */}
      {!isSimple && (requestedStaffName || requestedStaffReadyClock) ? (
        <p
          data-testid="queue-staff-dispatch"
          className="mt-2 flex items-center justify-between gap-2 text-[11px] text-nq-muted"
        >
          {requestedStaffName ? (
            <span className="inline-flex items-center gap-1 truncate">
              <span aria-hidden className="text-nq-primary">
                ●
              </span>
              <span className="truncate">{requestedStaffName}</span>
            </span>
          ) : (
            <span />
          )}
          {requestedStaffReadyClock ? (
            <span className="shrink-0 font-mono tabular-nums">
              {labels.readyAroundShort.replace(
                "{time}",
                requestedStaffReadyClock,
              )}
            </span>
          ) : null}
        </p>
      ) : null}

      {staffRequestedByClient && !isSimple ? (
        <p
          data-testid="queue-requested-by-client"
          className="mt-1 text-[11px] font-medium text-rose-600"
        >
          <span aria-hidden>❤️ </span>
          {labels.requestedByClientLine}
        </p>
      ) : null}

      {showSourceChip || (!isSimple && tags.length > 0) ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {showSourceChip && source ? (
            <QueueChip
              type="source"
              variant={queueSourceToChipVariant(source)}
              size="sm"
              label={
                source === "walk_in" ? labels.sourceFallback : source
              }
            />
          ) : null}
          {!isSimple ? tags.map((tag, idx) => (
            <QueueChip
              key={`${tag}-${idx}`}
              type="request"
              size="sm"
              label={tag}
            />
          )) : null}
        </div>
      ) : null}

      {actions ? <div className="mt-3">{actions}</div> : null}
    </Card>
  );
}

export default QueueEntryCard;
