"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "@/shared/lib/cn";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import {
  Badge,
  type BadgeState,
  type BadgeVariant,
} from "@/components/ui/Badge";

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "arrived"
  | "waiting"
  | "in_service"
  | "completed"
  | "cancelled"
  | "no_show"
  | "late"
  | "rescheduled";

const BOOKING_MOTION = {
  fastSec: 0.1,
  pulsePeriodSec: 2.0,
  ease: [0.22, 1, 0.36, 1] as const,
} as const;

const HOVER_SCALE = 1.01;

const cardStatusClasses: Record<BookingStatus, string> = {
  pending: "border-nq-border bg-nq-surface",
  confirmed: "border-nq-info/45 bg-nq-info/10",
  arrived: "border-nq-info/65 bg-nq-info/15",
  waiting: "border-nq-warning/45 bg-nq-warning/15",
  in_service: "border-nq-success/45 bg-nq-success/15",
  completed: "border-nq-border/60 bg-nq-surface/60 opacity-70",
  cancelled: "border-nq-error/30 bg-nq-error/10 opacity-60",
  no_show: "border-nq-error/55 bg-nq-error/15",
  late: "border-nq-error/55 bg-nq-error/15",
  rescheduled: "border-nq-info/30 bg-nq-info/10",
};

const statusBadgeVariant: Record<BookingStatus, BadgeVariant> = {
  pending: "neutral",
  confirmed: "info",
  arrived: "info",
  waiting: "warning",
  in_service: "success",
  completed: "neutral",
  cancelled: "danger",
  no_show: "danger",
  late: "danger",
  rescheduled: "info",
};

const statusBadgeState: Record<BookingStatus, BadgeState> = {
  pending: "subtle",
  confirmed: "default",
  arrived: "default",
  waiting: "default",
  in_service: "default",
  completed: "subtle",
  cancelled: "subtle",
  no_show: "default",
  late: "default",
  rescheduled: "subtle",
};

const statusLabels: Record<BookingStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  arrived: "Arrived",
  waiting: "Waiting",
  in_service: "In service",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
  late: "Late",
  rescheduled: "Rescheduled",
};

export type BookingCardProps = {
  customerName: string;
  serviceName: string;
  startTime: string;
  endTime: string;
  duration: number;
  status: BookingStatus;
  isVip?: boolean;
  isLate?: boolean;
  hasNotes?: boolean;
  hasDesign?: boolean;
  staffName?: string;
  onClick?: () => void;
  className?: string;
};

export function BookingCard({
  customerName,
  serviceName,
  startTime,
  endTime,
  duration,
  status,
  isVip = false,
  isLate = false,
  hasNotes = false,
  hasDesign = false,
  staffName,
  onClick,
  className,
}: BookingCardProps) {
  const reduced = useReducedMotion();
  const interactive = typeof onClick === "function";
  const showLatePulse = isLate || status === "late";
  const ariaLabel = `${customerName} - ${serviceName} - ${statusLabels[status]}`;

  const handleClick = (_: ReactMouseEvent<HTMLDivElement>) => {
    if (interactive) onClick?.();
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  };

  const hasIcons = isVip || hasNotes || showLatePulse || hasDesign;

  return (
    <motion.div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      whileHover={
        interactive && !reduced ? { scale: HOVER_SCALE } : undefined
      }
      transition={{
        duration: BOOKING_MOTION.fastSec,
        ease: BOOKING_MOTION.ease,
      }}
      className={cn(
        "relative select-none rounded-2xl border p-3",
        "outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
        cardStatusClasses[status],
        interactive && "cursor-pointer",
        isVip && "ring-1 ring-nq-primary/45",
        className,
      )}
    >
      {showLatePulse ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-2xl ring-2 ring-nq-error"
          initial={{ opacity: 0.55 }}
          animate={reduced ? undefined : { opacity: [0.55, 1, 0.55] }}
          transition={{
            duration: BOOKING_MOTION.pulsePeriodSec,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      ) : null}

      <div className="relative flex gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Badge
            variant={statusBadgeVariant[status]}
            state={statusBadgeState[status]}
            size="sm"
            dot
          >
            {statusLabels[status]}
          </Badge>
          <div className="truncate text-sm font-semibold text-nq-foreground">
            {customerName}
          </div>
          <div className="truncate text-xs text-nq-muted">{serviceName}</div>
          <div className="text-xs tabular-nums text-nq-muted">
            {startTime} – {endTime} · {duration}m
          </div>
          {staffName ? (
            <div className="truncate text-xs text-nq-muted">
              with {staffName}
            </div>
          ) : null}
        </div>

        {hasIcons ? (
          <div className="flex shrink-0 flex-col items-center gap-1.5 pt-0.5 text-sm leading-none">
            {isVip ? (
              <span aria-label="VIP" title="VIP">
                ⭐
              </span>
            ) : null}
            {hasNotes ? (
              <span aria-label="Has notes" title="Has notes">
                📝
              </span>
            ) : null}
            {showLatePulse ? (
              <motion.span
                aria-label="Late"
                title="Late"
                initial={{ opacity: 0.9 }}
                animate={reduced ? undefined : { opacity: [0.9, 1, 0.9] }}
                transition={{
                  duration: BOOKING_MOTION.pulsePeriodSec,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              >
                <Badge variant="danger" size="sm" state="default">
                  ⚠
                </Badge>
              </motion.span>
            ) : null}
            {hasDesign ? (
              <span aria-label="Design" title="Design">
                🎨
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

export default BookingCard;
