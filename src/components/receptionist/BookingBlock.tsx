"use client";

import type React from "react";
import { Star, Heart, Users, Palette, HeartHandshake, Clock, Play } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { cn } from "@/shared/lib/cn";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { serviceShortName } from "@/shared/booking/serviceShortName";
import {
  bookingSourceIcon,
  type BookingSourceLabels,
} from "@/shared/booking/bookingSourceIcon";
import { type LatenessTier } from "./lateness";

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

// Deterministic group color from UUID — 6 distinct hues that read well on both
// light/dark status backgrounds. Walkin gold (nq-primary) is intentionally
// excluded so the group band never clashes with the walk-in accent.
const GROUP_PALETTE = [
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f43f5e", // rose
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#06b6d4", // cyan
] as const;

// Narrow blocks clip long names mid-character with overflow-wrap:normal.
// Show "First L." for medium blocks, first name only for very narrow ones.
// Full name is always in tooltipTitle (hover) and the detail drawer.
function formatDisplayName(name: string, widthPx: number): string {
  if (widthPx >= 160) return name;
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return name;
  if (widthPx >= 100) return `${parts[0]} ${parts[parts.length - 1][0]}.`;
  return parts[0];
}

function groupColorFromId(groupId: string): string {
  let h = 0;
  for (let i = 0; i < groupId.length; i++) {
    h = (h * 31 + groupId.charCodeAt(i)) & 0xffff;
  }
  return GROUP_PALETTE[h % GROUP_PALETTE.length];
}

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
  /** Width (px) of the trailing reset buffer baked into this block's span.
   * When > 0, a faint hatched overlay marks the tail so the desk can tell
   * service time from the cleanup gap. Purely visual — schedule math (the
   * full span incl. buffer) is unchanged. */
  bufferWidthPx?: number;
  /** Buffer length in minutes — drives the hatched tail's tooltip text. */
  bufferMinutes?: number;
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
  /**
   * UUID of the group this booking belongs to. When provided alongside
   * `isGroup`, a deterministic accent color is applied to the left border
   * so all members of the same group share the same color on the timeline.
   */
  groupId?: string | null;
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
    /** "Start" — inline start button label (used as aria-label too). */
    startShort?: string;
    /** "Auto no-show at {time}" template. */
    autoNoShowAt?: (time: string) => string;
    /** "Late" badge text. */
    lateChip?: string;
    /** "Very late" badge text. */
    veryLateChip?: string;
  };
  /** Lateness tier for confirmed/pending past start (null = not late / not applicable). */
  latenessTier?: LatenessTier;
  /** Wall-clock time when the cron will auto-mark no_show (in salon tz) — shown in the badge. */
  autoNoShowAtLabel?: string;
  /** Called when the inline "Start" button is tapped (only provided when viewer can change status). */
  onStart?: () => void;
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
  /** Assigned resource name ("Bed 3") shown as a small pill under the service line.
   * Only rendered when resources_enabled is on for the salon. */
  resourceName?: string | null;
  /** Controlled Owner/Admin exception; renders a compact moon marker. */
  afterHoursMinutes?: number | null;
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
    bufferWidthPx = 0,
    bufferMinutes = 0,
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
    groupId = null,
    seatTogether = false,
    compactIcons = false,
    iconLabels = DEFAULT_ICON_LABELS,
    sourceLabelFull,
    currencyCode,
    onPointerDown,
    isDragging = false,
    latenessTier = null,
    autoNoShowAtLabel,
    onStart,
    resourceName,
    afterHoursMinutes = null,
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

  // Lateness escalation only applies to a not-yet-started booking past its start
  // (confirmed/pending). `isLate` (in_progress past END) is a separate overlay.
  const showLateness =
    latenessTier !== null &&
    status !== "in_progress" &&
    status !== "completed";
  // Compact source-icon-stack clock marker for late/critical (paired with the
  // ring so the signal isn't hue-only). `due` stays calm — ring only.
  const showLateIcon = showLateness && latenessTier !== "due";
  const showStartButton = onStart !== undefined && showLateness;

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
    showLateIcon ||
    hasDesign ||
    isGroup ||
    seatTogether;
    // Moon is text rather than a new icon dependency; it remains recognizable
    // in every density and is paired with an accessible label.
  const isAfterHours =
    afterHoursMinutes != null && Number(afterHoursMinutes) > 0;
  const hasAnyIcons = hasIcons || isAfterHours;

  const lateChipLabel =
    latenessTier === "critical"
      ? (iconLabels as { veryLateChip?: string })?.veryLateChip ?? "Very late"
      : (iconLabels as { lateChip?: string })?.lateChip ?? "Late";
  const autoNoShowTip =
    showLateness && autoNoShowAtLabel
      ? (iconLabels as { autoNoShowAt?: (t: string) => string })?.autoNoShowAt?.(
          autoNoShowAtLabel,
        ) ?? `Auto no-show at ${autoNoShowAtLabel}`
      : null;

  // Lightweight hover tooltip carrying the un-truncated essentials so the
  // icon-only / short-name compaction never hides operational info.
  const tooltipTitle = [
    clientName,
    serviceName,
    sourceMeta ? `Source: ${sourceMeta.label}` : null,
    sourceLabelFull && !sourceMeta ? sourceLabelFull : null,
    showLateness ? autoNoShowTip ?? lateChipLabel : null,
  ]
    .filter(Boolean)
    .join("\n");

  // When density supplies an explicit min-height, the inline `style` on
  // the wrapper takes precedence over the default 52px floor — sized so a
  // two-line client name (P0: names must never truncate) clears the block
  // padding. Density still drives the grid floor (Simple 56px, Balanced
  // 52px, Pro 44px) without breaking the timeline math.
  // Group color: deterministic accent from group UUID, shown as a 3px left border.
  // Takes priority over the walkin gold border so the group association is always visible.
  const groupAccent = isGroup && groupId ? groupColorFromId(groupId) : null;

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
    isCompleted && "opacity-70",
    // While dragging, hide the ORIGINAL block so only the moving dashed ghost
    // (with the live snap time) shows — one clean block instead of two.
    isDragging && "opacity-0",
    isDraggable && "cursor-grab touch-none select-none",
    onClick && !isDraggable && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--drc-accent,#c9a96e)]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
  );

  // Left accent border priority:
  //  1. Group color (deterministic per group_id — highest priority)
  //  2. DRC theme accent (var(--drc-accent), cascades from root)
  //  3. Fallback: NailIQ gold (#c9a96e)
  // Applied via inline style so Tailwind's border shorthand in STATUS_STYLES can't override it.
  const accentBorderColor = groupAccent ?? "var(--drc-accent, #c9a96e)";

  const style: React.CSSProperties = {
    left: leftPx,
    width: Math.max(0, widthPx - 4),
    ...(minHeightPx !== undefined ? { minHeight: minHeightPx } : {}),
    borderLeftWidth: "3px",
    borderLeftStyle: "solid",
    borderLeftColor: accentBorderColor,
  };

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

      {/* Lateness escalation ring (confirmed/pending past start) — RING ONLY, no
          floating badge: the countdown lives in the tooltip + the icon-stack
          clock so dense blocks stay clean. `isLate` (in_progress past end) is a
          separate overlay above. due = soft amber · late = amber · critical =
          pulsing red. */}
      {showLateness ? (
        latenessTier === "critical" ? (
          <motion.span
            aria-hidden
            data-testid={`booking-block-lateness-${bookingId}`}
            className="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-nq-error"
            initial={{ opacity: 0.55 }}
            animate={reduced ? undefined : { opacity: [0.55, 1, 0.55] }}
            transition={{
              duration: PULSE_PERIOD_SEC,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        ) : (
          <span
            aria-hidden
            data-testid={`booking-block-lateness-${bookingId}`}
            className={cn(
              "pointer-events-none absolute inset-0 rounded-lg ring-2",
              latenessTier === "late" ? "ring-nq-warning" : "ring-nq-warning/55",
            )}
          />
        )
      ) : null}

      {/* Inline "Start" — compact icon-only play button so it never crowds the
          client/service/time text on a dense block (gated on viewer can-change-
          status + lateness). Stops propagation so it doesn't open the drawer. */}
      {showStartButton ? (
        <button
          type="button"
          aria-label={
            (iconLabels as { startShort?: string })?.startShort ?? "Start"
          }
          title={(iconLabels as { startShort?: string })?.startShort ?? "Start"}
          data-testid={`booking-block-start-${bookingId}`}
          className="pointer-events-auto absolute bottom-1 right-1 z-[2] flex h-6 w-6 items-center justify-center rounded-full bg-nq-success text-white shadow-sm ring-1 ring-black/10 transition-transform hover:scale-110 active:scale-95"
          onClick={(e) => {
            e.stopPropagation();
            onStart?.();
          }}
        >
          <Play size={11} strokeWidth={2.5} fill="currentColor" />
        </button>
      ) : null}

      {bufferWidthPx >= 3 ? (
        // Reset/cleanup buffer tail — a faint hatched strip at the block's
        // right edge with a dashed divider at the service-end boundary, so the
        // desk reads where the actual service stops and the buffer begins.
        // currentColor stripes keep it visible on every status background +
        // dark mode; pointer-events-none so it never blocks click/drag.
        <span
          aria-hidden
          data-testid={`booking-block-buffer-${bookingId}`}
          title={
            bufferMinutes > 0
              ? `Đệm dọn dẹp ${bufferMinutes} phút`
              : "Đệm dọn dẹp"
          }
          className="pointer-events-none absolute inset-y-0 right-0 rounded-r-lg border-l border-dashed border-current/40 opacity-25"
          style={{
            width: bufferWidthPx,
            backgroundImage:
              "repeating-linear-gradient(45deg, currentColor 0, currentColor 1.5px, transparent 1.5px, transparent 6px)",
          }}
        />
      ) : null}

      <div className="relative flex min-w-0 gap-2">
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            // Reserve room at the bottom-right for the icon-only Start button so
            // it never overlaps the service/time text on a dense block.
            showStartButton && "pr-7",
          )}
        >
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
            {formatDisplayName(clientName, widthPx)}
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
          {resourceName ? (
            <p
              className={cn(
                "truncate text-[10px] leading-snug font-medium opacity-70",
                styles.meta,
              )}
              title={resourceName}
            >
              🛏 {resourceName}
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

        {hasAnyIcons ? (
          <div
            data-testid={`booking-block-icons-${bookingId}`}
            className={cn(
              "flex shrink-0 items-center gap-1 pt-0.5 leading-none opacity-90",
              compactIcons
                ? "max-w-16 flex-row flex-wrap justify-end"
                : "flex-col",
            )}
          >
            {showLateIcon ? (
              <Clock
                size={13}
                strokeWidth={2.5}
                aria-label={lateChipLabel}
                className={
                  latenessTier === "critical"
                    ? "text-[var(--color-nq-error)]"
                    : "text-[var(--color-nq-warning)]"
                }
                data-testid={`booking-block-icon-late-${bookingId}`}
              />
            ) : null}
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
            {isAfterHours ? (
              <span
                aria-label={`After hours · ${afterHoursMinutes} minutes`}
                title={`After hours · ${afterHoursMinutes} minutes`}
                data-testid={`booking-block-icon-after-hours-${bookingId}`}
                className="text-xs leading-none"
              >
                🌙
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
        data-booking-source={source}
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
      data-booking-source={source}
      data-testid={`booking-block-${bookingId}`}
    >
      {inner}
    </div>
  );
}
