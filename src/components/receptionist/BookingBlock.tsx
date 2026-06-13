"use client";

import { Star, Heart, Users, Palette, HeartHandshake } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { cn } from "@/shared/lib/cn";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { serviceShortName } from "@/shared/booking/serviceShortName";
import {
  bookingSourceIcon,
  type BookingSourceLabels,
} from "@/shared/booking/bookingSourceIcon";

/**
 * Booking timeline cell.
 *
 * Layout (`COMPONENT_RULES.md` §2 — `BookingCard`-aligned scan order):
 *   1. Customer name (semibold, wraps to 2 lines — never truncated)
 *   2. Service name (xs muted, truncate)
 *   3. Time range + price (xs tabular-nums)
 *
 * Icon stack at the right edge (renders only when at least one flag is
 * true; column is hidden entirely otherwise so dense rows stay scannable
 * per `UX_PRINCIPLES.md` §2 rule 5). P1 readability polish: Lucide icons
 * (premium, consistent) replace emoji; source shows icon-only; the notes
 * indicator is dropped from the compact block (notes live in the detail
 * drawer) to keep the client/service/time text legible.
 *   - source     (Mic/Globe/Phone/UserPlus/Calendar — `sourceChannel`)
 *   - Star VIP   (`isVip`)
 *   - Heart req. (`hasStaffRequest` — non-empty `staff_request_note`)
 *   - Users grp. (`isGroup` — group / party / wave bookings share group_id)
 *   - ⚠ Late      (`isLate` overlay flag — see `STATE_MACHINE.md` §3+§5)
 *   - Palette     (`hasDesign`)
 *
 * The compact service line uses `serviceShortName()` (display-only); the
 * block's `title` tooltip and the detail drawer always carry the full
 * client name, full service name, and full source label.
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
  /**
   * Raw source channel from `bookings.source` (e.g. "voice", "online",
   * "phone", "walkin", "appointment"). Drives the compact source icon.
   * Optional — falls back to `source` when omitted. Icon-only on the
   * block; the full label appears in the tooltip + detail drawer.
   */
  sourceChannel?: string;
  startTimeLabel: string;
  /** Optional end-of-service label rendered as `start – end` on line 3. */
  endTimeLabel?: string;
  priceCents: number | null;
  /** P0.2 — salon's configured currency. Drives the price string in
   * the time/price line (CAD/USD/VND), replacing the prior hardcoded
   * "$" prefix. Optional for back-compat — callers without a salon
   * row in scope fall back to CAD via `parseCurrency`. */
  currencyCode?: import("@/shared/lib/currencyFormat").Currency;
  leftPx: number;
  widthPx: number;
  onClick?: () => void;
  /** When false, hides price segment in the meta line (`revenue_today` desk module). */
  showPrice?: boolean;
  /**
   * Density-driven flag. When false (Simple density), the SERVICE NAME
   * line is hidden so blocks read as client-name-only chips. Default
   * true preserves Balanced/Pro behavior + back-compat with callers
   * that don't thread density.
   */
  showMetaLine?: boolean;
  /**
   * Density-driven flag. When false (Simple + Balanced), the time
   * range + price line is hidden — Balanced shows name + service
   * only; the timeline axis itself communicates time. Pro flips this
   * on so receptionists get the in-block time/price stamp. Default
   * true preserves the prior all-or-nothing behavior.
   */
  showTimeRange?: boolean;
  /**
   * Density-driven minimum height (px). Visual override only — schedule
   * math is unchanged. Default 52px floor (`min-h-[3.25rem]`) still wins
   * when this is omitted — sized for a two-line client name.
   */
  minHeightPx?: number;
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
  /** Booking has a non-empty `staff_request_note`. Renders the heart
   * icon in the icon stack so the receptionist sees the preferred-
   * staff request without opening the drawer. */
  hasStaffRequest?: boolean;
  /** Number of add-ons on the booking — renders a "+N" badge on the chip. */
  addonCount?: number;
  /** Client's lifetime no-show count — shows a ⚠ badge for repeat offenders (≥2). */
  noShowCount?: number;
  /** AI no-show risk score (0–100) for this booking. A score ≥70 on a
   *  not-yet-arrived booking shows an amber risk ⚠ so the desk can act early. */
  noShowRiskScore?: number | null;
  /**
   * Overlay flag — `status === 'in_progress'` AND service end time has
   * passed. Per `STATE_MACHINE.md` §5 (auto-transition `in_service +
   * time exceeded → late`), this is layered on top of the underlying
   * state, not a replacement.
   */
  isLate?: boolean;
  /** Booking is part of a group (migration 20260512200000). Renders
   * the 👥 marker in the icon stack so receptionists can identify
   * grouped bookings at a glance. */
  isGroup?: boolean;
  /** Group/couple asked to be seated next to each other (migration
   * 20260607100000). Renders a 💕 marker so reception knows to set up
   * adjacent beds + a shared curtain. */
  seatTogether?: boolean;
  /** Basic Mode: render the critical-icon cluster as a compact horizontal
   * row (wraps) instead of a tall vertical stack. Same icons, cleaner. */
  compactIcons?: boolean;
  /** Localized accessible labels for the icon stack (so VI/EN parity stays clean). */
  iconLabels?: {
    vip: string;
    notes: string;
    late: string;
    design: string;
    /** Aria label for the heart shown when `hasStaffRequest` is true. */
    staffRequest: string;
    /** Aria label for the group marker shown when `isGroup` is true. */
    group?: string;
    /** Aria label for the 💕 marker shown when `seatTogether` is true. */
    seatTogether?: string;
    /** Localized source labels for the compact source icon (a11y title). */
    source?: BookingSourceLabels;
  };
  /**
   * Optional full source label for the hover tooltip (e.g. "Source: Walk-in").
   * The detail drawer carries the authoritative source label; this is a
   * lightweight scannability aid on hover.
   */
  sourceLabelFull?: string;
  /** Grid drag-and-drop — fires on pointerdown when dragging is enabled. */
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  /** True while this block is being dragged — renders semi-transparent. */
  isDragging?: boolean;
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
  staffRequest: "Staff request",
  group: "Group booking",
  seatTogether: "Seat together",
} as const;

function formatPrice(
  priceCents: number | null,
  currencyCode: import("@/shared/lib/currencyFormat").Currency | undefined,
): string {
  if (priceCents == null) return "—";
  // P0.2 — render in the salon's currency. `formatCurrency` returns
  // null only for null/NaN/negative input; we've already null-guarded
  // priceCents above so the fallback path is just defensive.
  return formatCurrency(priceCents, currencyCode) ?? "—";
}

export function BookingBlock(props: BookingBlockProps) {
  const {
    bookingId,
    clientName,
    serviceName,
    status,
    source,
    sourceChannel,
    startTimeLabel,
    endTimeLabel,
    priceCents,
    leftPx,
    widthPx,
    onClick,
    showPrice = true,
    showMetaLine = true,
    showTimeRange = true,
    minHeightPx,
    showWalkinAccent = true,
    isVip = false,
    hasDesign = false,
    hasStaffRequest = false,
    addonCount = 0,
    noShowCount = 0,
    noShowRiskScore = null,
    isLate = false,
    isGroup = false,
    seatTogether = false,
    compactIcons = false,
    iconLabels = DEFAULT_ICON_LABELS,
    sourceLabelFull,
    currencyCode,
    onPointerDown,
    isDragging = false,
  } = props;

  const reduced = useReducedMotion();
  const styles = STATUS_STYLES[status];
  const pricePart = formatPrice(priceCents, currencyCode);

  // Line 3: time range (+ price when `revenue_today` is on). Time stays
  // the leading token so scan order matches the timeline axis.
  const timeRange = endTimeLabel
    ? `${startTimeLabel} – ${endTimeLabel}`
    : startTimeLabel;
  const timePriceLine = showPrice ? `${timeRange} · ${pricePart}` : timeRange;

  const isWalkin = source === "walkin";
  const isCompleted = status === "completed";

  // Compact service label (display-only); full name stays in the tooltip + drawer.
  const serviceLabel = serviceShortName(serviceName);

  // Source icon (icon-only on the block; full label in tooltip + drawer).
  const sourceLabels = (iconLabels as { source?: BookingSourceLabels }).source;
  const sourceMeta = bookingSourceIcon(sourceChannel ?? source, sourceLabels);

  const hasIcons =
    !!sourceMeta ||
    isVip ||
    hasStaffRequest ||
    isLate ||
    hasDesign ||
    isGroup ||
    seatTogether;

  // Lightweight hover tooltip carrying the un-truncated essentials so the
  // icon-only / short-name compaction never hides operational info.
  const tooltipTitle = [
    clientName,
    serviceName,
    sourceMeta ? `Source: ${sourceMeta.label}` : null,
    sourceLabelFull && !sourceMeta ? sourceLabelFull : null,
  ]
    .filter(Boolean)
    .join("\n");

  // When density supplies an explicit min-height, the inline `style` on
  // the wrapper takes precedence over the default 52px floor — sized so a
  // two-line client name (P0: names must never truncate) clears the block
  // padding. Density still drives the grid floor (Simple 56px, Balanced
  // 52px, Pro 44px) without breaking the timeline math.
  const isDraggable = !!onPointerDown && (status === "pending" || status === "confirmed");
  const commonClass = cn(
    // pointer-events-auto: the timeline wraps blocks in a pointer-events-none
    // layer (so clicks on EMPTY gaps fall through to the slot-create layer
    // below). pointer-events is inherited, so each block must explicitly
    // re-enable it or the wrapper's `none` cascades in and the block becomes
    // unclickable (no drawer, no drag).
    "pointer-events-auto absolute top-1.5 bottom-1.5 rounded-lg px-2.5 py-1.5 text-left shadow-none transition-[transform,box-shadow,opacity] duration-[var(--duration-nq-fast)] ease-[var(--ease-nq-out)] motion-safe:hover:-translate-y-px motion-safe:hover:shadow-nq-card",
    minHeightPx === undefined && "min-h-[3.25rem]",
    styles.root,
    isWalkin && showWalkinAccent && "border-l-[3px] border-nq-primary",
    isCompleted && "opacity-70",
    isDragging && "opacity-40 shadow-nq-card scale-[0.97]",
    isDraggable && "cursor-grab touch-none select-none",
    onClick && !isDraggable && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
  );

  const style = {
    left: leftPx,
    width: Math.max(0, widthPx - 4),
    ...(minHeightPx !== undefined ? { minHeight: minHeightPx } : {}),
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
          {/* `break-words` removed: it split names mid-word in narrow cells
              ("Liam (O…", "Gue…"). A 2-line clamp wraps at word boundaries
              (multi-word names stay readable) and ellipsizes the 2nd line;
              `[overflow-wrap:normal]` keeps single words from being chopped.
              The full name is always in the tooltip (title) + detail drawer. */}
          <p className="line-clamp-2 text-sm font-semibold leading-tight [overflow-wrap:normal]">
            {noShowCount >= 2 ? (
              <span
                className="mr-1 align-middle text-[var(--color-nq-error)]"
                title={`Đã vắng ${noShowCount} lần`}
                aria-label={`No-show ${noShowCount} times`}
              >
                ⚠
              </span>
            ) : (noShowRiskScore ?? 0) >= 70 &&
              (status === "pending" || status === "confirmed") ? (
              // First-time / occasional guest the AI flags as high no-show risk —
              // amber (distinct from the red repeat-offender ⚠) so the desk can
              // confirm/deposit early.
              <span
                className="mr-1 align-middle text-[var(--color-nq-warning)]"
                title="Nguy cơ vắng cao — nên xác nhận trước"
                aria-label="High no-show risk"
              >
                ⚠
              </span>
            ) : null}
            {clientName}
          </p>
          {showMetaLine ? (
            <p className={cn("truncate text-[11px] leading-snug", styles.meta)}>
              {serviceLabel}
              {addonCount > 0 ? (
                <span
                  className="ml-1 rounded-full bg-[var(--salon-primary)]/20 px-1.5 py-px text-[10px] font-semibold text-[var(--salon-primary)] align-middle"
                  title={`${addonCount} add-on${addonCount > 1 ? "s" : ""}`}
                >
                  +{addonCount}
                </span>
              ) : null}
            </p>
          ) : null}
          {showTimeRange ? (
            <p
              className={cn(
                "truncate font-mono text-[11px] tabular-nums leading-snug",
                styles.meta,
              )}
            >
              {timePriceLine}
            </p>
          ) : null}
        </div>

        {hasIcons ? (
          <div
            data-testid={`booking-block-icons-${bookingId}`}
            className={cn(
              "flex shrink-0 items-center gap-1 pt-0.5 leading-none opacity-90",
              compactIcons
                ? "max-w-16 flex-row flex-wrap justify-end"
                : "flex-col",
            )}
          >
            {sourceMeta ? (
              <sourceMeta.Icon
                size={13}
                strokeWidth={2}
                aria-label={sourceMeta.label}
                data-testid={`booking-block-icon-source-${bookingId}`}
              />
            ) : null}
            {isVip ? (
              <Star
                size={13}
                strokeWidth={2}
                fill="currentColor"
                aria-label={iconLabels.vip}
                data-testid={`booking-block-icon-vip-${bookingId}`}
              />
            ) : null}
            {hasStaffRequest ? (
              <Heart
                size={13}
                strokeWidth={2}
                fill="currentColor"
                aria-label={iconLabels.staffRequest}
                data-testid={`booking-block-icon-staff-request-${bookingId}`}
              />
            ) : null}
            {isGroup ? (
              <Users
                size={13}
                strokeWidth={2}
                aria-label={iconLabels.group ?? "Group booking"}
                data-testid={`booking-block-icon-group-${bookingId}`}
              />
            ) : null}
            {seatTogether ? (
              <HeartHandshake
                size={13}
                strokeWidth={2}
                className="text-nq-primary"
                aria-label={iconLabels.seatTogether ?? "Seat together"}
                data-testid={`booking-block-icon-seat-together-${bookingId}`}
              />
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
              <Palette
                size={13}
                strokeWidth={2}
                aria-label={iconLabels.design}
                data-testid={`booking-block-icon-design-${bookingId}`}
              />
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
        title={tooltipTitle}
        aria-label={`Booking ${bookingId}: ${clientName}`}
        onClick={onClick}
        onPointerDown={onPointerDown}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      className={commonClass}
      style={style}
      title={tooltipTitle}
      data-booking-id={bookingId}
      data-testid={`booking-block-${bookingId}`}
    >
      {inner}
    </div>
  );
}
