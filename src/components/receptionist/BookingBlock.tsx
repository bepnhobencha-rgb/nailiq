"use client";

import { Badge } from "@/components/ui/Badge";
import { cn } from "@/shared/lib/cn";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";

/**
 * Booking timeline cell.
 *
 * Layout (`COMPONENT_RULES.md` §2 — `BookingCard`-aligned scan order):
 *   1. Customer name (semibold, truncate)
 *   2. Service name (xs muted, truncate)
 *   3. Time range + price (xs tabular-nums)
 *
 * Icon stack at the right edge (renders only when at least one flag is
 * true; column is hidden entirely otherwise so dense rows stay scannable
 * per `UX_PRINCIPLES.md` §2 rule 5):
 *   - ⭐ VIP        (`isVip`)
 *   - 📝 Notes      (`hasNotes`)
 *   - ⚠ Late        (`isLate` overlay flag — see `STATE_MACHINE.md` §3+§5)
 *   - 🎨 Design     (`hasDesign`)
 *
 * Late treatment uses a danger-pulse keyline ring around the block plus
 * a danger Badge in the icon stack — pair color with text label per
 * `COLOR_TOKENS.md` §5. Pulse motion is allowed for actionable critical
 * desk signals only per `ANIMATION_RULES.md` §3 (Badge pulse / overlay
 * pulse). Reduced-motion users get a static danger ring + static badge.
 *
 * Status colors are intentionally narrow to the four states actually
 * emitted into `bookingsForDay` (see `BOOKING_DAY_STATUSES`). The other
 * `STATE_MACHINE.md` states (`waiting`, `cancelled`, `no_show`,
 * `arrived`, `late`-as-state, `rescheduled`) are out-of-scope for this
 * surface — `waiting` lives in the queue panel, terminal states are
 * filtered, and `late` is an overlay (see `isLate`), not a replacement
 * status.
 */

const PULSE_PERIOD_SEC = 2.0; // see `BookingCard.tsx` BOOKING_MOTION.pulsePeriodSec — same operational rhythm.

export interface BookingBlockProps {
  bookingId: string;
  clientName: string;
  serviceName: string;
  status: "pending" | "confirmed" | "in_progress" | "completed";
  source: "appointment" | "walkin";
  startTimeLabel: string;
  /** Optional end-of-service label rendered as `start – end` on line 3. */
  endTimeLabel?: string;
  priceCents: number | null;
  leftPx: number;
  widthPx: number;
  onClick?: () => void;
  /** When false, hides price segment in the meta line (`revenue_today` desk module). */
  showPrice?: boolean;
  /** When false, drops walk-in left accent (`vip_indicators` uses walk-in lane styling). */
  showWalkinAccent?: boolean;
  /** Walk-in `walkin_source === 'vip'` (server-derived). */
  isVip?: boolean;
  /** Booking has non-empty `client_notes`. */
  hasNotes?: boolean;
  /**
   * Service catalog name suggests nail-art / design (server-derived
   * heuristic against `(nail\s*art|design)` until a structured flag
   * exists).
   */
  hasDesign?: boolean;
  /**
   * Overlay flag — `status === 'in_progress'` AND service end time has
   * passed. Per `STATE_MACHINE.md` §5 (auto-transition `in_service +
   * time exceeded → late`), this is layered on top of the underlying
   * state, not a replacement.
   */
  isLate?: boolean;
  /** Localized accessible labels for the icon stack (so VI/EN parity stays clean). */
  iconLabels?: {
    vip: string;
    notes: string;
    late: string;
    design: string;
  };
}

/**
 * Background + meta-text classes per status. Only the four reachable
 * states are encoded; see component-level comment for the rationale on
 * the others.
 *
 * `pending` previously used `bg-nq-primary-soft` (gold tint) which
 * conflicts with `COLOR_TOKENS.md` §6 — gold is reserved for VIP /
 * brand commitment. Repainted to the warning family which matches the
 * doc's `pending` yellow intent without overloading the gold semantic.
 */
const STATUS_STYLES: Record<
  BookingBlockProps["status"],
  { root: string; meta: string }
> = {
  pending: {
    root: "bg-nq-warning/15 text-nq-foreground border border-nq-warning/45",
    meta: "text-nq-foreground/85",
  },
  confirmed: {
    root: "bg-nq-info text-nq-foreground",
    meta: "text-nq-foreground/85",
  },
  in_progress: {
    root: "bg-nq-success text-nq-foreground",
    meta: "text-nq-foreground/85",
  },
  completed: {
    root: "bg-nq-muted/45 text-nq-foreground",
    meta: "text-nq-foreground/70",
  },
};

const DEFAULT_ICON_LABELS = {
  vip: "VIP",
  notes: "Notes",
  late: "Late",
  design: "Design",
} as const;

function formatPrice(priceCents: number | null): string {
  if (priceCents == null) return "—";
  return (priceCents / 100).toFixed(2);
}

export function BookingBlock(props: BookingBlockProps) {
  const {
    bookingId,
    clientName,
    serviceName,
    status,
    source,
    startTimeLabel,
    endTimeLabel,
    priceCents,
    leftPx,
    widthPx,
    onClick,
    showPrice = true,
    showWalkinAccent = true,
    isVip = false,
    hasNotes = false,
    hasDesign = false,
    isLate = false,
    iconLabels = DEFAULT_ICON_LABELS,
  } = props;

  const reduced = useReducedMotion();
  const styles = STATUS_STYLES[status];
  const pricePart =
    priceCents != null ? `$${formatPrice(priceCents)}` : formatPrice(priceCents);

  // Line 3: time range (+ price when `revenue_today` is on). Time stays
  // the leading token so scan order matches the timeline axis.
  const timeRange = endTimeLabel
    ? `${startTimeLabel} – ${endTimeLabel}`
    : startTimeLabel;
  const timePriceLine = showPrice ? `${timeRange} · ${pricePart}` : timeRange;

  const isWalkin = source === "walkin";
  const isCompleted = status === "completed";
  const hasIcons = isVip || hasNotes || isLate || hasDesign;

  const commonClass = cn(
    "absolute top-1.5 bottom-1.5 min-h-11 rounded-lg px-2.5 py-1.5 text-left shadow-none transition-[transform,box-shadow] duration-[var(--duration-nq-fast)] ease-[var(--ease-nq-out)] motion-safe:hover:-translate-y-px motion-safe:hover:shadow-nq-card",
    styles.root,
    isWalkin && showWalkinAccent && "border-l-[3px] border-nq-primary",
    isCompleted && "opacity-70",
    onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
  );

  const style = {
    left: leftPx,
    width: Math.max(0, widthPx - 4),
  } as const;

  const inner = (
    <>
      {isLate ? (
        <motion.span
          aria-hidden
          data-testid={`booking-block-late-overlay-${bookingId}`}
          className="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-nq-error"
          initial={{ opacity: 0.55 }}
          animate={reduced ? undefined : { opacity: [0.55, 1, 0.55] }}
          transition={{
            duration: PULSE_PERIOD_SEC,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      ) : null}

      <div className="relative flex min-w-0 gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm font-semibold leading-tight">
            {clientName}
          </p>
          <p className={cn("truncate text-[11px] leading-snug", styles.meta)}>
            {serviceName}
          </p>
          <p
            className={cn(
              "truncate font-mono text-[11px] tabular-nums leading-snug",
              styles.meta,
            )}
          >
            {timePriceLine}
          </p>
        </div>

        {hasIcons ? (
          <div
            data-testid={`booking-block-icons-${bookingId}`}
            className="flex shrink-0 flex-col items-center gap-1 pt-0.5 text-sm leading-none"
          >
            {isVip ? (
              <span aria-label={iconLabels.vip} title={iconLabels.vip}>
                ⭐
              </span>
            ) : null}
            {hasNotes ? (
              <span aria-label={iconLabels.notes} title={iconLabels.notes}>
                📝
              </span>
            ) : null}
            {isLate ? (
              <motion.span
                aria-label={iconLabels.late}
                title={iconLabels.late}
                initial={{ opacity: 0.9 }}
                animate={reduced ? undefined : { opacity: [0.9, 1, 0.9] }}
                transition={{
                  duration: PULSE_PERIOD_SEC,
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
              <span aria-label={iconLabels.design} title={iconLabels.design}>
                🎨
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={`booking-block-${bookingId}`}
        className={cn(commonClass, "appearance-none border-0")}
        style={style}
        aria-label={`Booking ${bookingId}: ${clientName}`}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      className={commonClass}
      style={style}
      data-booking-id={bookingId}
      data-testid={`booking-block-${bookingId}`}
    >
      {inner}
    </div>
  );
}
