"use client";

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { computeLatenessTier } from "./lateness";
import { formatCurrency } from "@/shared/lib/currencyFormat";

import { BookingBlock } from "./BookingBlock";
import { GhostBlock } from "./GhostBlock";
import { NowLine } from "./NowLine";
import { StaffAvatar, type StaffStatus } from "@/components/ui/StaffAvatar";
import {
  checkBookingConflict,
  type ConflictCheckBooking,
} from "@/shared/lib/conflictCheck";
import { cn } from "@/shared/lib/cn";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import {
  salonNowMinutes,
  salonWallTimeToUtcIso,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";
import { minutesToLabel } from "@/shared/booking/getAvailableTimeSlots";
import { canOfferGridCreateStart } from "@/shared/booking/gridCreateAvailability";

// Default visible window when nothing forces it wider. The grid expands beyond
// this to cover any booking outside it + the current time (so a 1:44 AM walk-in
// has a real, clickable slot and the now-line/scroll-to-now work off-hours).
const DEFAULT_HOUR_START = 8;
const DEFAULT_HOUR_END = 20;
const SLOT_MINUTES = 30;
const SLOT_PX = 64;
const ROW_HEIGHT = 76;
const STAFF_COL_WIDTH = 140;
const TIME_HEADER_HEIGHT = 44;
// Minimum pointer movement (px) before a pointerdown is promoted to an active drag.
// Below this threshold the interaction is treated as a click and the drawer opens normally.
const DRAG_THRESHOLD_PX = 5;

export interface GridStaff {
  id: string;
  name: string;
  job_role: string;
  /**
   * Operational availability — drives `StaffAvatar` status dot. Computed
   * server-side in `loadReceptionistCenterData` from today's bookings +
   * `staff.status` (inactive/pending → "offline").
   */
  status: StaffStatus;
  /**
   * Relative workload 0–100 for the day; busiest staff = 100. Rendered as
   * the bar under the avatar when `staff_performance` module is on.
   */
  workload: number;
}

export interface GridBooking {
  id: string;
  client_name: string;
  service_name: string;
  service_id: string;
  status: "pending" | "confirmed" | "in_progress" | "completed";
  source: "appointment" | "walkin";
  /** Raw source channel for the compact source icon (e.g. "voice", "online"). */
  source_channel?: string | null;
  staff_id: string;
  start_time_utc: string;
  end_time_utc: string;
  price_cents: number | null;
  /**
   * Server-derived booking-block icon flags (see
   * `loadReceptionistCenterData.ts` for the derivation rules — no new
   * DB columns).
   */
  is_vip: boolean;
  has_notes: boolean;
  has_design: boolean;
  /** Booking carries a non-empty `staff_request_note`. Drives the
   * heart icon in the booking-block icon stack. */
  has_staff_request: boolean;
  /** Booking belongs to a group (migration 20260512200000) — drives
   * the 👥 marker on the chip. */
  group_id?: string | null;
  /** Couple/group "seat together" preference (migration 20260607100000)
   * — drives the 💕 marker on the chip. */
  seat_together?: boolean;
  /** Number of add-ons on this booking — drives the "+N" chip badge. */
  addon_count?: number;
  /** Per-service reset/cleanup buffer (minutes) baked into the block's
   * `end_time_utc`. Drives the hatched "buffer tail" overlay so the desk can
   * see where the service actually ends and the reset gap begins. */
  buffer_minutes?: number;
  /** Client's lifetime no-show count — drives a ⚠ chip badge for repeat offenders. */
  no_show_count?: number;
  /** AI no-show risk score (0–100) — drives an amber risk ⚠ on the block. */
  no_show_risk_score?: number | null;
  /** Scheduler-produced flag requiring a human attendance decision. */
  no_show_candidate_at?: string | null;
  /** No-show fee lifecycle for the booking's no-show card — used by the tombstone. */
  noshow_charge_status?: string | null;
  noshow_card_id?: string | null;
  noshow_fee_cents?: number | null;
  /** Assigned resource name ("Bed 3") — shown as a small pill badge under the service name.
   * Only populated when resources_enabled is on for the salon. */
  resource_name?: string | null;
  /** Minutes the customer-facing service runs beyond close for a controlled
   * Owner/Admin override. */
  after_hours_minutes?: number | null;
}

export interface StaffTimelineGridProps {
  staff: GridStaff[];
  bookings: GridBooking[];
  assigning: {
    queueItemId: string;
    clientName: string;
    serviceDurationMinutes: number;
  } | null;
  selectedDate: string;
  /**
   * Salon open/close minutes-from-midnight for the selected day (from
   * `salons.opening_hours`). Sets the grid's DEFAULT visible window so a
   * booking-free day shows real business hours instead of a fixed 8a–8p.
   * `null` (closed/unset) falls back to the 8a–8p default. The window still
   * widens past these to fit off-hours bookings + the current time.
   */
  openMinutes?: number | null;
  closeMinutes?: number | null;
  /**
   * Shortest customer-facing main service each staff member can perform.
   * `null` means the staff member has no bookable main service.
   */
  minimumServiceMinutesByStaff?: Record<string, number | null>;
  timezone: string;
  nowIso: string;
  /** When false, hide now line and skip jump-to-now scrolling (yesterday/tomorrow). */
  isViewingToday: boolean;
  /** Increment (e.g. from parent) to smooth-scroll to the current time column. */
  jumpToNowTrigger: number;
  existingBookings: GridBooking[];
  onBookingClick: (bookingId: string) => void;
  onSlotClick: (staffId: string, slotStartUtc: string) => void;
  /**
   * Click-to-create: fires when the receptionist clicks a genuinely EMPTY
   * slot while NOT in walk-in assign mode. Opens the desk booking form
   * prefilled with this staff + day + time label. `ymd` is salon-local
   * YYYY-MM-DD; `timeLabel` is the exact `minutesToLabel` label so the
   * form can auto-select the matching slot.
   */
  onEmptySlotClick?: (
    staffId: string,
    ymd: string,
    timeLabel: string,
    /** Viewport coords of the click → lets the form open as a card anchored at
     *  the clicked cell instead of a grid-covering modal (desktop). */
    anchor?: { x: number; y: number },
  ) => void;
  /** Drag-to-reschedule: fires when a booking block is dropped on a new slot. */
  onRescheduleBooking?: (
    bookingId: string,
    newStaffId: string,
    newStartUtc: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  labels: {
    formatTimeLabel: (utc: string) => string;
    conflictWith: (clientName: string) => string;
    overflowMessage: string;
    /** Localized word shown on the display-only closing-time marker
     *  (e.g. "Close" / "Đóng cửa"). */
    closingLabel: string;
    /** Soft waitlist-offer marker: title ("Đang mời khách chờ" /
     *  "Offering to waitlist"). Optional — falls back to a bilingual
     *  inline default keyed off `language` when omitted. */
    waitlistOffer?: string;
    /** Soft waitlist-offer marker: expiry suffix ("đến HH:MM" /
     *  "until HH:MM"). Optional — inline fallback like above. */
    waitlistOfferUntil?: (time: string) => string;
    /** Localized label for a redacted/removed customer ("[removed]" in DB). */
    removedGuest: string;
    /**
     * Localized icon-stack labels for the booking block. Optional —
     * defaults to English titles in `BookingBlock` when omitted.
     */
    bookingIcon?: {
      vip: string;
      notes: string;
      late: string;
      design: string;
      /** Aria label for the heart icon shown when the booking has a
       * non-empty staff request note. */
      staffRequest: string;
      /** "Start" — inline start button label. */
      startShort?: string;
      /** "No-show review due at {time}" template. */
      autoNoShowAt?: (time: string) => string;
      /** "Late" badge text. */
      lateChip?: string;
      /** "Very late" badge text. */
      veryLateChip?: string;
      /** Persisted scheduler flag requiring a human attendance decision. */
      noShowDecisionNeeded?: string;
    };
    /** Localized strings for lateness grid UI and tombstone popovers. */
    latenessGrid?: {
      startShort: string;
      autoNoShowAt: (time: string) => string;
      late: string;
      veryLate: string;
      noShowDecisionNeeded: string;
      tombstoneAria: (clientName: string) => string;
      tombstoneUndo: string;
      tombstoneCharge: (amount: string) => string;
      tombstoneWaive: string;
      tombstoneCharged: (amount: string) => string;
      tombstoneWaived: string;
      tombstoneFailed: string;
      tombstoneUnpaid: (amount: string) => string;
      tombstoneNoCard: string;
    };
  };
  /** When false, hides per-staff role line and busy ring on avatars (`staff_performance`). */
  showStaffPerformanceDetail?: boolean;
  /** When false, softens vertical slot dividers (`timeline_heatmap`). */
  showTimelineHeatmap?: boolean;
  /** Passed to each booking block (`revenue_today`). */
  showBookingPrices?: boolean;
  /** Passed to each booking block (`vip_indicators`). */
  showWalkinAccent?: boolean;
  /**
   * Density-derived flag — controls the SERVICE NAME line on booking
   * blocks. Off in `simple` density to keep blocks calm; on otherwise.
   */
  showBookingMetaLine?: boolean;
  /**
   * Density-derived flag — controls the time-range + price line on
   * booking blocks. Off in `simple` and `balanced`; on in `pro`. The
   * price segment still requires `showBookingPrices` to be true (gates
   * compose).
   */
  showBookingTimeRange?: boolean;
  /**
   * Density-derived visual override for booking block minimum height
   * (px). Visual only — schedule math (slot count + GIST overlap)
   * remains on the salon's true 30-minute cadence.
   */
  bookingBlockMinHeightPx?: number;
  /** P0.2 — salon's configured currency for the price line. */
  currencyCode?: import("@/shared/lib/currencyFormat").Currency;
  /**
   * Density-derived visual hint for slot row height tier (20 / 30 / 40
   * minutes equivalent). Visual only — does not change `SLOT_PX` or
   * `TOTAL_SLOTS`. Reserved for future density-driven row-height
   * adjustments; currently unused but plumbed so the contract stays
   * stable as density tightens.
   */
  timeSlotMinutesVisualHint?: 20 | 30 | 40;
  /** Basic Mode: render booking-block critical icons as a compact
   * horizontal cluster instead of a vertical stack. Default false
   * (Balanced/Advanced keep the existing vertical stack). */
  compactBookingIcons?: boolean;
  /** Minutes past start when the cron flags desk review. Null = auto OFF. */
  autoNoShowMinutes?: number | null;
  /** No-show tombstones to render as thin ribbons on the grid. */
  noShowTombstones?: Array<{
    id: string;
    clientName: string;
    startTimeUtc: string;
    endTimeUtc: string;
    staffId: string | null;
    feeCents: number | null;
    chargeStatus: string | null;
    hasCard: boolean;
  }>;
  /**
   * Active online-waitlist "soft holds" to render as informational markers.
   * When a cancelled booking's freed slot has been texted to a waiting online
   * customer (20-min claim window), the cell looks empty — these dashed amber
   * ribbons tell staff "đang mời khách chờ" so they don't give it to a walk-in.
   * The marker is `pointer-events-none` so staff CAN still override the cell.
   */
  waitlistOffers?: Array<{
    id: string;
    staffId: string;
    startUtc: string;
    endUtc: string;
    expiresAtUtc: string;
    serviceName: string;
  }>;
  /** Called when the "Start" inline button is clicked on a late block. */
  onStartBooking?: (bookingId: string) => void;
  /** Language for tombstone popover labels. */
  language?: "en" | "vi";
  /** Tombstone charge/waive/undo handlers. */
  onTombstoneUndo?: (bookingId: string) => void;
  onTombstoneCharge?: (bookingId: string) => void;
  onTombstoneWaive?: (bookingId: string) => void;
}

function slotIndexToUtc(
  slotIndex: number,
  selectedDate: string,
  timezone: string,
  hourStart: number,
): string {
  const minutesFromMidnight = hourStart * 60 + slotIndex * SLOT_MINUTES;
  return salonWallTimeToUtcIso(selectedDate, minutesFromMidnight, timezone);
}

function bookingToPosition(
  booking: GridBooking,
  timezone: string,
  hourStart: number,
) {
  const startMin = utcIsoToSalonMinutesFromMidnight(
    booking.start_time_utc,
    timezone,
  );
  const minutesFromStart = startMin - hourStart * 60;
  const durationMin =
    (Date.parse(booking.end_time_utc) - Date.parse(booking.start_time_utc)) /
    60_000;
  // Trailing buffer width — the reset gap baked into end_time_utc. Clamp to the
  // block span so a misconfigured buffer can never paint past the block edge.
  const bufferMin = Math.max(
    0,
    Math.min(Number(booking.buffer_minutes ?? 0) || 0, durationMin),
  );
  return {
    leftPx: (minutesFromStart / SLOT_MINUTES) * SLOT_PX,
    widthPx: (durationMin / SLOT_MINUTES) * SLOT_PX,
    bufferWidthPx: (bufferMin / SLOT_MINUTES) * SLOT_PX,
  };
}

function computeNowLineLeftPx(
  nowIso: string,
  timezone: string,
  hourStart: number,
  hourEnd: number,
): number | null {
  const m = salonNowMinutes(timezone, nowIso);
  const gridStart = hourStart * 60;
  const gridEnd = hourEnd * 60;
  if (m < gridStart || m >= gridEnd) {
    return null;
  }
  const minutesFromStart = m - gridStart;
  return (minutesFromStart / SLOT_MINUTES) * SLOT_PX;
}

/** Nearest 30-minute slot center for scroll alignment (≈ ±15 min from "now"). */
function computeNearestSlotCenterLeftPx(
  nowIso: string,
  timezone: string,
  hourStart: number,
  hourEnd: number,
  totalSlots: number,
): number | null {
  const m = salonNowMinutes(timezone, nowIso);
  const gridStart = hourStart * 60;
  const gridEnd = hourEnd * 60;
  if (m < gridStart || m >= gridEnd) {
    return null;
  }
  const minutesFromStart = m - gridStart;
  const slotIndex = Math.round(minutesFromStart / SLOT_MINUTES);
  const clamped = Math.max(0, Math.min(totalSlots - 1, slotIndex));
  return clamped * SLOT_PX + SLOT_PX / 2;
}

/**
 * Compute the visible hour window. Starts from the salon's default window and
 * widens to include every booking on screen + (today) the current time — so
 * off-hours bookings always have a real slot and now-line math stays valid.
 */
function computeHourRange(
  allBookings: GridBooking[],
  timezone: string,
  includeNowIso: string | null,
  baseStartHour: number,
  baseEndHour: number,
): { hourStart: number; hourEnd: number } {
  let startH = baseStartHour;
  let endH = baseEndHour;
  for (const b of allBookings) {
    const startMin = utcIsoToSalonMinutesFromMidnight(
      b.start_time_utc,
      timezone,
    );
    const durMin =
      (Date.parse(b.end_time_utc) - Date.parse(b.start_time_utc)) / 60_000;
    if (!Number.isFinite(startMin)) continue;
    const endMin = startMin + (Number.isFinite(durMin) ? durMin : 0);
    startH = Math.min(startH, Math.floor(startMin / 60));
    endH = Math.max(endH, Math.ceil(endMin / 60));
  }
  if (includeNowIso) {
    const m = salonNowMinutes(timezone, includeNowIso);
    if (Number.isFinite(m)) {
      // Only widen for "now" when the current salon time falls within open hours.
      // Off-hours "now" (e.g. 4 am when salon opens at 9 am) must not stretch
      // the grid backwards — that's confusing to staff viewing the day.
      const nowH = Math.floor(m / 60);
      if (nowH >= baseStartHour && nowH < baseEndHour) {
        startH = Math.min(startH, nowH);
        // +1 slot so "now" near the hour edge still has a column to its right.
        endH = Math.max(endH, Math.ceil((m + SLOT_MINUTES) / 60));
      }
    }
  }
  startH = Math.max(0, startH);
  endH = Math.min(24, Math.max(endH, startH + 1));
  return { hourStart: startH, hourEnd: endH };
}

function toConflictRows(bookings: GridBooking[]): ConflictCheckBooking[] {
  return bookings.map((b) => ({
    id: b.id,
    staff_id: b.staff_id,
    start_time_utc: b.start_time_utc,
    end_time_utc: b.end_time_utc,
    status: b.status,
    client_name: b.client_name,
  }));
}

interface GridDragState {
  bookingId: string;
  serviceId: string;
  originalStaffId: string;
  originalStartUtc: string;
  durationMinutes: number;
  /** px from the left edge of the block where the user grabbed it. */
  grabOffsetPx: number;
  clientName: string;
  targetStaffIdx: number;
  /** Target start as salon minutes-from-midnight. May be OFF the 15-min grid
   *  when snapped to a preceding booking's exact end (back-to-back drop). */
  targetStartMin: number;
  /** True when the start locked onto a preceding booking's exact end (flush
   *  back-to-back) — drives the "🧲 liền sau" snap affordance on the ghost. */
  targetSnappedToEnd: boolean;
}

function StaffTimelineGridImpl({
  staff,
  bookings,
  assigning,
  selectedDate,
  openMinutes,
  closeMinutes,
  minimumServiceMinutesByStaff,
  timezone,
  nowIso,
  isViewingToday,
  jumpToNowTrigger,
  existingBookings,
  onBookingClick,
  onSlotClick,
  onEmptySlotClick,
  onRescheduleBooking,
  labels,
  showStaffPerformanceDetail = true,
  showTimelineHeatmap = true,
  showBookingPrices = true,
  showWalkinAccent = true,
  showBookingMetaLine = true,
  showBookingTimeRange = true,
  bookingBlockMinHeightPx,
  currencyCode,
  compactBookingIcons = false,
  autoNoShowMinutes,
  noShowTombstones,
  waitlistOffers,
  onStartBooking,
  language = "en",
  onTombstoneUndo,
  onTombstoneCharge,
  onTombstoneWaive,
  // `timeSlotMinutesVisualHint` is reserved for future row-height
  // adjustments; currently unused at runtime.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- ARCHITECTURE_LOCK: reserved for future row-height adjustments
  timeSlotMinutesVisualHint: _timeSlotMinutesVisualHint,
}: StaffTimelineGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrolledRef = useRef(false);
  const prevJumpTriggerRef = useRef(0);

  const [hoveredSlot, setHoveredSlot] = useState<{
    staffId: string;
    slotIndex: number;
  } | null>(null);

  // Click-to-create hover preview: which staff row + 15-min sub-slot the pointer
  // is over. Drives a ghost cell + a "Staff · time" pill so the receptionist
  // sees exactly who/when a click will book BEFORE clicking (QA: clicks near a
  // row edge used to land on the wrong tech silently).
  const [createHover, setCreateHover] = useState<{
    staffId: string;
    /** Salon minutes-from-midnight of the previewed start. Usually a 15-min
     *  grid value, but snaps to a preceding booking's exact end (e.g. 1:25)
     *  when hovering just after it — back-to-back, no dead grid gap. */
    startMin: number;
    leftPx: number;
  } | null>(null);
  const [blockedCreateHoverStaffId, setBlockedCreateHoverStaffId] = useState<
    string | null
  >(null);

  const [dragState, setDragState] = useState<GridDragState | null>(null);
  const dragStateRef = useRef<GridDragState | null>(null);
  // eslint-disable-next-line react-hooks/refs -- ARCHITECTURE_LOCK: ref sync during render is the intended pattern for stable pointer-handler reads
  dragStateRef.current = dragState;
  // Stable refs so global pointer handlers read the latest values without
  // re-registering on every render.
  const staffRef = useRef(staff);
  // eslint-disable-next-line react-hooks/refs -- ARCHITECTURE_LOCK: ref sync during render; intentional stable-ref pattern
  staffRef.current = staff;
  const selectedDateRef = useRef(selectedDate);
  // eslint-disable-next-line react-hooks/refs -- ARCHITECTURE_LOCK: ref sync during render; intentional stable-ref pattern
  selectedDateRef.current = selectedDate;
  const timezoneRef = useRef(timezone);
  // eslint-disable-next-line react-hooks/refs -- ARCHITECTURE_LOCK: ref sync during render; intentional stable-ref pattern
  timezoneRef.current = timezone;
  const onRescheduleRef = useRef(onRescheduleBooking);
  // eslint-disable-next-line react-hooks/refs -- ARCHITECTURE_LOCK: ref sync during render; intentional stable-ref pattern
  onRescheduleRef.current = onRescheduleBooking;

  // Visible hour window — widens past the default 8a–8p to fit off-hours
  // bookings + (today) the current time, so every block has a slot and the
  // now-line/scroll math stays valid at any hour.
  const { hourStart, hourEnd } = useMemo(() => {
    // Base window from the salon's opening hours for the day; fall back to the
    // 8a–8p default when closed/unset. floor(open)/ceil(close) snap to whole
    // hours so the header labels stay clean.
    const baseStart =
      openMinutes != null ? Math.floor(openMinutes / 60) : DEFAULT_HOUR_START;
    const baseEnd =
      closeMinutes != null ? Math.ceil(closeMinutes / 60) : DEFAULT_HOUR_END;
    return computeHourRange(
      [...bookings, ...existingBookings],
      timezone,
      isViewingToday ? nowIso : null,
      baseStart,
      baseEnd,
    );
  }, [
    bookings,
    existingBookings,
    timezone,
    isViewingToday,
    nowIso,
    openMinutes,
    closeMinutes,
  ]);
  const totalSlots = (hourEnd - hourStart) * 2;
  const timelineWidthPx = totalSlots * SLOT_PX;
  // Refs so the always-on pointer handlers read the live window without
  // re-registering (same stable-ref pattern as the other drag inputs).
  const hourStartRef = useRef(hourStart);
  // eslint-disable-next-line react-hooks/refs -- ARCHITECTURE_LOCK: ref sync during render; intentional stable-ref pattern
  hourStartRef.current = hourStart;
  const totalSlotsRef = useRef(totalSlots);
  // eslint-disable-next-line react-hooks/refs -- ARCHITECTURE_LOCK: ref sync during render; intentional stable-ref pattern
  totalSlotsRef.current = totalSlots;

  // Pending drag: pointer is down but hasn't yet exceeded DRAG_THRESHOLD_PX.
  // Stored as a ref (not state) so we don't re-register global handlers on every
  // pointerdown — handlers are always-on and check both refs.
  const pendingDragRef = useRef<{
    bookingId: string;
    serviceId: string;
    staffId: string;
    startUtc: string;
    durationMinutes: number;
    clientName: string;
    startX: number;
    startY: number;
    grabOffsetPx: number;
    initialStaffIdx: number;
    initialSlotIdx: number;
  } | null>(null);
  // Set to true when a drag is promoted; blocks the spurious click that some
  // browsers fire after pointerup even when the pointer moved significantly.
  const recentlyDraggedRef = useRef(false);

  const bookingsByStaff = useMemo(() => {
    const m = new Map<string, GridBooking[]>();
    for (const b of bookings) {
      const list = m.get(b.staff_id) ?? [];
      list.push(b);
      m.set(b.staff_id, list);
    }
    return m;
  }, [bookings]);
  // Ref mirror so the once-registered pointer handlers can read live bookings
  // (for back-to-back drag snapping) without going stale. Keep this sync effect
  // before the handler-registration effect below so the initial value and every
  // subsequent booking update are observable before pointer events run.
  const bookingsByStaffRef = useRef(bookingsByStaff);
  useEffect(() => {
    bookingsByStaffRef.current = bookingsByStaff;
  }, [bookingsByStaff]);

  // Always-on global handlers — noops when both refs are null (i.e. nothing
  // is being dragged). Registered once via empty deps; all live state is read
  // through refs so closures never go stale.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const pending = pendingDragRef.current;
      const ds = dragStateRef.current;
      const scroll = scrollRef.current;

      if (pending) {
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
          // Promote to active drag — clear pending so the next move goes to
          // the position-update branch.
          recentlyDraggedRef.current = true;
          pendingDragRef.current = null;
          setCreateHover(null); // clear any create-preview so only the drag ghost shows
          setDragState({
            bookingId: pending.bookingId,
            serviceId: pending.serviceId,
            originalStaffId: pending.staffId,
            originalStartUtc: pending.startUtc,
            durationMinutes: pending.durationMinutes,
            grabOffsetPx: pending.grabOffsetPx,
            clientName: pending.clientName,
            targetStaffIdx: pending.initialStaffIdx,
            targetStartMin: Math.round(
              utcIsoToSalonMinutesFromMidnight(
                pending.startUtc,
                timezoneRef.current,
              ),
            ),
            targetSnappedToEnd: false,
          });
        }
        return;
      }

      if (!ds || !scroll) return;

      const rect = scroll.getBoundingClientRect();
      const relX = e.clientX - rect.left - STAFF_COL_WIDTH + scroll.scrollLeft;
      const relY = e.clientY - rect.top - TIME_HEADER_HEIGHT + scroll.scrollTop;

      const staffIdx = Math.max(
        0,
        Math.min(staffRef.current.length - 1, Math.floor(relY / ROW_HEIGHT)),
      );

      // Target start in salon minutes from the pointer (block's left edge =
      // pointer − grab offset). Snap to the 15-min grid, clamped to the visible
      // day window.
      const hourStartMin = hourStartRef.current * 60;
      const pxPerMin = SLOT_PX / SLOT_MINUTES;
      const gridEndMin = hourStartMin + totalSlotsRef.current * SLOT_MINUTES;
      const rawMin = hourStartMin + (relX - ds.grabOffsetPx) / pxPerMin;
      let startMin = Math.round(rawMin / 15) * 15;
      startMin = Math.max(
        hourStartMin,
        Math.min(gridEndMin - ds.durationMinutes, startMin),
      );
      // Back-to-back snap: if a booking on the TARGET staff ends very close to
      // where the pointer is (closer than the 15-min grid point), snap the
      // block's start to that exact end — even off-grid (e.g. 1:10) — so it sits
      // flush after it. Excludes the booking being dragged.
      const targetStaffId = staffRef.current[staffIdx]?.id;
      let flush = false;
      if (targetStaffId) {
        const rows = bookingsByStaffRef.current.get(targetStaffId) ?? [];
        const otherEnds = rows
          .filter((b) => b.id !== ds.bookingId)
          .map((b) =>
            Math.round(
              utcIsoToSalonMinutesFromMidnight(
                b.end_time_utc,
                timezoneRef.current,
              ),
            ),
          );
        // Snap to a preceding booking's exact end when the pointer is closer to
        // it than to the 15-min grid point — reaches OFF-grid ends (e.g. 1:10).
        let bestEnd: number | null = null;
        let bestDist = Math.abs(startMin - rawMin);
        for (const endMin of otherEnds) {
          const dist = Math.abs(endMin - rawMin);
          if (dist < bestDist && dist <= 15 && endMin + ds.durationMinutes <= gridEndMin) {
            bestDist = dist;
            bestEnd = endMin;
          }
        }
        if (bestEnd !== null) startMin = bestEnd;
        // Magnet shows whenever the block STARTS exactly when another booking
        // ENDS — i.e. truly back-to-back — regardless of whether that end falls
        // on the 15-min grid (1:15) or off it (1:10). Previously it only lit for
        // off-grid ends, so adjacent on-grid bookings confusingly had no magnet.
        flush = otherEnds.includes(startMin);
      }

      setDragState((prev) =>
        prev &&
        (prev.targetStartMin !== startMin ||
          prev.targetStaffIdx !== staffIdx ||
          prev.targetSnappedToEnd !== flush)
          ? {
              ...prev,
              targetStartMin: startMin,
              targetStaffIdx: staffIdx,
              targetSnappedToEnd: flush,
            }
          : prev,
      );
    };

    const onUp = () => {
      const pending = pendingDragRef.current;
      const ds = dragStateRef.current;

      if (pending) {
        // Released without reaching the threshold — clear pending; the normal
        // click event will fire and open the drawer.
        pendingDragRef.current = null;
        return;
      }

      if (!ds) return;

      const targetStaff = staffRef.current[ds.targetStaffIdx];
      const slotStartUtc = salonWallTimeToUtcIso(
        selectedDateRef.current,
        ds.targetStartMin,
        timezoneRef.current,
      );

      const noChange =
        targetStaff?.id === ds.originalStaffId &&
        slotStartUtc === ds.originalStartUtc;

      if (!noChange && targetStaff && onRescheduleRef.current) {
        void onRescheduleRef.current(
          ds.bookingId,
          targetStaff.id,
          slotStartUtc,
        );
      }

      setDragState(null);
      // Clear the drag guard after the click event has had a chance to fire
      // (browsers dispatch click synchronously after pointerup, so 50ms is ample).
      setTimeout(() => {
        recentlyDraggedRef.current = false;
      }, 50);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const conflictRows = useMemo(
    () => toConflictRows(existingBookings),
    [existingBookings],
  );

  const nowLineLeftPx = useMemo(() => {
    if (!isViewingToday) return null;
    return computeNowLineLeftPx(nowIso, timezone, hourStart, hourEnd);
  }, [isViewingToday, nowIso, timezone, hourStart, hourEnd]);

  const nowLineLabel = useMemo(
    () => (nowIso ? labels.formatTimeLabel(nowIso) : ""),
    [labels, nowIso],
  );

  // Display-only closing-time marker. The last BOOKABLE slot starts
  // SLOT_MINUTES before close (e.g. 6:30p for a 7:00p close), so without a
  // marker the grid "ends" at 6:30 and reads as if the salon closes then.
  // This pins a static line + label at the true close gridline. Null when the
  // day is closed/unset or close falls outside the (possibly widened) window.
  const closingLeftPx = useMemo(() => {
    if (closeMinutes == null) return null;
    const gridStart = hourStart * 60;
    const gridEnd = hourEnd * 60;
    if (closeMinutes < gridStart || closeMinutes > gridEnd) return null;
    return ((closeMinutes - gridStart) / SLOT_MINUTES) * SLOT_PX;
  }, [closeMinutes, hourStart, hourEnd]);

  const closingTimeLabel = useMemo(() => {
    if (closeMinutes == null) return null;
    return labels.formatTimeLabel(
      salonWallTimeToUtcIso(selectedDate, closeMinutes, timezone),
    );
  }, [closeMinutes, selectedDate, timezone, labels]);

  const slotUtcList = useMemo(
    () =>
      Array.from({ length: totalSlots }, (_, i) =>
        slotIndexToUtc(i, selectedDate, timezone, hourStart),
      ),
    [selectedDate, timezone, totalSlots, hourStart],
  );

  useEffect(() => {
    autoScrolledRef.current = false;
  }, [selectedDate]);

  useEffect(() => {
    if (!isViewingToday || autoScrolledRef.current) return;
    const el = scrollRef.current;
    const snapPx = computeNearestSlotCenterLeftPx(
      nowIso,
      timezone,
      hourStart,
      hourEnd,
      totalSlots,
    );
    if (snapPx === null || !el) return;
    autoScrolledRef.current = true;
    const w = el.clientWidth;
    const maxScroll = Math.max(0, el.scrollWidth - w);
    const target = Math.max(0, Math.min(snapPx - w / 2, maxScroll));
    el.scrollLeft = target;
  }, [
    isViewingToday,
    nowIso,
    timezone,
    selectedDate,
    hourStart,
    hourEnd,
    totalSlots,
  ]);

  useEffect(() => {
    if (!isViewingToday) return;
    if (jumpToNowTrigger <= prevJumpTriggerRef.current) return;
    prevJumpTriggerRef.current = jumpToNowTrigger;
    const el = scrollRef.current;
    const snapPx = computeNearestSlotCenterLeftPx(
      nowIso,
      timezone,
      hourStart,
      hourEnd,
      totalSlots,
    );
    if (snapPx === null || !el) return;
    const w = el.clientWidth;
    const maxScroll = Math.max(0, el.scrollWidth - w);
    const target = Math.max(0, Math.min(snapPx - w / 2, maxScroll));
    el.scrollTo({ left: target, behavior: "smooth" });
  }, [
    jumpToNowTrigger,
    isViewingToday,
    nowIso,
    timezone,
    hourStart,
    hourEnd,
    totalSlots,
  ]);

  const assignMode = assigning !== null;
  // Click-to-create is active when we're NOT assigning a walk-in AND the
  // parent wired a handler. In this mode clicking a genuinely empty slot
  // opens the desk booking form prefilled. Mutually exclusive with assign.
  const clickToCreate = !assignMode && !!onEmptySlotClick;

  // Start-validity check for click-to-create only — does NOT affect assign
  // mode. The preview is shown only when at least one main service that this
  // staff member can perform would finish before close.
  const isSlotCreatable = (
    staffStatus: StaffStatus,
    staffId: string,
    startMinutes: number,
  ): boolean =>
    canOfferGridCreateStart({
      staffIsActive: staffStatus !== "offline",
      startMinutes,
      openMinutes,
      closeMinutes,
      minimumServiceMinutes: minimumServiceMinutesByStaff?.[staffId],
    });

  return (
    <div
      ref={scrollRef}
      data-testid="staff-timeline-grid"
      // tabIndex allows keyboard users to scroll the timeline grid in Safari (scrollable-region-focusable).
      tabIndex={0}
      className={cn(
        "h-full min-h-0 overflow-auto",
        assignMode && "cursor-copy",
        dragState !== null && "cursor-grabbing select-none",
      )}
    >
      <div className="inline-flex min-w-max flex-row">
        <div
          className={cn(
            "sticky left-0 z-[15] flex shrink-0 flex-col border-r border-nq-muted/25",
          )}
          style={{ backgroundColor: "var(--drc-bg, #0b0c10)" }}
        >
          <div
            className="sticky top-0 z-[25] shrink-0"
            style={{ width: STAFF_COL_WIDTH, height: TIME_HEADER_HEIGHT, backgroundColor: "var(--drc-bg, #0b0c10)" }}
            aria-hidden
          />

          {staff.map((s) => (
            <div
              key={s.id}
              className={cn(
                "flex shrink-0 items-center gap-2.5 border-b border-nq-muted/15 px-2",
              )}
              style={{ width: STAFF_COL_WIDTH, height: ROW_HEIGHT }}
            >
              {/*
               * Sanctioned `StaffAvatar` primitive (`src/components/ui/`).
               * Status dot replaces the previous custom busy-ring; the
               * `staff_performance` module gate now governs the workload
               * bar + role text below. The dot itself stays visible
               * regardless — basic availability signal is core
               * operational truth, not analytics chrome.
               */}
              <StaffAvatar
                name={s.name}
                status={s.status}
                workload={s.workload}
                showWorkload={showStaffPerformanceDetail}
                showStatus
                size="md"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-nq-foreground">
                  {s.name}
                </p>
                {showStaffPerformanceDetail ? (
                  <p className="truncate text-[11px] text-nq-muted">
                    {s.job_role}
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col" style={{ width: timelineWidthPx }}>
          <div
            className={cn(
              "sticky top-0 z-12 flex shrink-0 backdrop-blur-sm",
              // `relative` anchors the floating NOW-time bubble (below)
              // inside the time-header strip; combined with the strip's
              // existing `sticky top-0` this keeps the bubble visible
              // during VERTICAL scroll, while it scrolls horizontally
              // with the timeline (i.e. tied to the NOW position on
              // the time axis).
              "relative",
            )}
            style={{ height: TIME_HEADER_HEIGHT, width: timelineWidthPx, backgroundColor: "var(--drc-bg, #0b0c10)" }}
          >
            {slotUtcList.map((utc, i) => {
              const isHourMark = i % 2 === 0;
              return (
                <div
                  key={i}
                  className={cn(
                    // Label is LEFT-aligned on the cell's left border (the
                    // gridline = slot START). Bookings + the NOW line are
                    // positioned at the slot-start gridline too, so centering
                    // the label mid-cell shifted every label ½ slot (15 min)
                    // right of its real time — making the NOW line look wrong.
                    "flex shrink-0 items-end justify-start border-l border-nq-muted/15 pb-1 pl-1",
                    isHourMark ? "text-nq-foreground" : "text-nq-muted",
                  )}
                  style={{ width: SLOT_PX, height: TIME_HEADER_HEIGHT }}
                >
                  <span
                    className={cn(
                      "font-mono text-[10px] tabular-nums leading-none",
                      isHourMark ? "font-semibold" : "font-medium",
                    )}
                  >
                    {labels.formatTimeLabel(utc)}
                  </span>
                </div>
              );
            })}
            {/*
             * Floating NOW-time bubble. Sits at the top of the timeline
             * header strip, centered over the NowLine's `leftPx`. The
             * strip itself is `sticky top-0`, so the bubble stays
             * vertically visible during vertical scroll. Horizontally
             * it scrolls with the timeline (correctly tied to "now" on
             * the time axis — receptionist still has the "Jump to now"
             * pill in the header to pull it back into view).
             *
             * Color matches the NowLine (red `--color-nq-error`); the
             * pill carries the textual "now" label so the temporal
             * anchor is conveyed by both color AND text per
             * `COLOR_TOKENS.md §5` ("never rely on hue alone").
             *
             * Hidden when `nowLineLeftPx` is null (off-grid time, e.g.
             * before 8am or after 8pm) and on non-today views (existing
             * `isViewingToday` gate already nulls `nowLineLeftPx`).
             */}
            {nowLineLeftPx !== null ? (
              <div
                data-testid="now-line-bubble"
                className={cn(
                  "pointer-events-none absolute top-1 z-[13] -translate-x-1/2",
                  "rounded-full bg-nq-error px-2 py-0.5",
                  "text-[10px] font-semibold tabular-nums text-white shadow-nq-card",
                )}
                style={{ left: nowLineLeftPx }}
              >
                {nowLineLabel}
              </div>
            ) : null}
            {/* Closing-time label, anchored to the LEFT of the close gridline
                (it sits at the grid's right edge) so it stays inside view. */}
            {closingLeftPx !== null && closingTimeLabel ? (
              <div
                data-testid="closing-marker"
                className={cn(
                  "pointer-events-none absolute bottom-1 z-[12] flex -translate-x-full items-center gap-1",
                  "rounded-l-md border border-r-0 border-nq-muted/25 bg-nq-bg/95 px-1.5 py-0.5",
                )}
                style={{ left: closingLeftPx }}
                aria-label={`${labels.closingLabel} ${closingTimeLabel}`}
              >
                <span className="font-mono text-[10px] font-semibold tabular-nums leading-none text-nq-muted">
                  {closingTimeLabel}
                </span>
                <span className="text-[9px] font-medium uppercase leading-none tracking-wide text-nq-muted">
                  {labels.closingLabel}
                </span>
              </div>
            ) : null}
          </div>

          <div
            className="relative"
            style={{
              height: staff.length * ROW_HEIGHT,
              width: timelineWidthPx,
            }}
          >
            {/* eslint-disable react-hooks/refs -- ARCHITECTURE_LOCK: staffRef.current accessed during render for drag-ghost target lookup; stable-ref pattern */}
            {staff.map((s) => {
              const rowBookings = bookingsByStaff.get(s.id) ?? [];
              // Resolve the click-to-create start from a cursor X (relative to
              // the row). Snaps to the 15-min grid, EXCEPT when the cursor is
              // just past a booking that ends off-grid (e.g. 1:25) — then it
              // snaps to that exact end so the new appointment sits back-to-back
              // with no dead gap, matching getAvailableTimeSlots' Phase-2 anchor.
              // Returns null when the slot isn't creatable (over a booking body,
              // off-hours, offline staff).
              const resolveCreateStart = (
                relX: number,
              ): { startMin: number; leftPx: number } | null => {
                const HALF_PX = SLOT_PX / 2; // 15 min
                const subSlot = Math.max(
                  0,
                  Math.min(totalSlots * 2 - 1, Math.floor(relX / HALF_PX)),
                );
                let startMin = hourStart * 60 + subSlot * 15;
                let gridLeftPx = subSlot * HALF_PX;
                for (const b of rowBookings) {
                  const { leftPx, widthPx } = bookingToPosition(
                    b,
                    timezone,
                    hourStart,
                  );
                  const rightPx = leftPx + widthPx;
                  if (gridLeftPx >= leftPx - 0.5 && gridLeftPx < rightPx - 0.5) {
                    // Cursor still over the booking body → nothing to create.
                    if (relX < rightPx - 0.5) return null;
                    // Cursor past the booking's end → snap to its exact end.
                    const endMin = Math.round(
                      utcIsoToSalonMinutesFromMidnight(b.end_time_utc, timezone),
                    );
                    startMin = endMin;
                    gridLeftPx = rightPx;
                    break;
                  }
                }
                if (!isSlotCreatable(s.status, s.id, startMin)) return null;
                return { startMin, leftPx: gridLeftPx };
              };
              // Drag-to-reschedule ghost — shown when a booking block is being dragged.
              const isDragTarget =
                dragState !== null &&
                staffRef.current[dragState.targetStaffIdx]?.id === s.id;
              let dragGhostEl: ReactNode = null;
              if (isDragTarget && dragState !== null) {
                const slotStartUtc = salonWallTimeToUtcIso(
                  selectedDate,
                  dragState.targetStartMin,
                  timezone,
                );
                const spanEndMs =
                  Date.parse(slotStartUtc) + dragState.durationMinutes * 60_000;
                const spanEndIso = new Date(spanEndMs).toISOString();
                const widthPx =
                  (dragState.durationMinutes / SLOT_MINUTES) * SLOT_PX;
                const leftPx =
                  ((dragState.targetStartMin - hourStart * 60) / SLOT_MINUTES) *
                  SLOT_PX;
                const overflowMin =
                  dragState.targetStartMin +
                  dragState.durationMinutes -
                  (hourStart * 60 + totalSlots * SLOT_MINUTES);
                const overflow = overflowMin > 0;
                const conflict = overflow
                  ? null
                  : checkBookingConflict({
                      staffId: s.id,
                      startUtcIso: slotStartUtc,
                      endUtcIso: spanEndIso,
                      existingBookings: conflictRows,
                      excludeBookingId: dragState.bookingId,
                    });
                // Show the exact span the block will land on — what-you-see is
                // what-you-get on release (no more "shows 1:15 but drops 1:10").
                const targetTimeLabel = labels.formatTimeLabel(slotStartUtc);
                const endTimeLabel = labels.formatTimeLabel(spanEndIso);
                const flush =
                  dragState.targetSnappedToEnd && !overflow && !conflict;
                let ghostState: "ok" | "conflict" | "overflow" = "ok";
                // The block itself shows just the name (narrow blocks truncate);
                // the readable time lives in the floating pill below.
                let ghostLabel = dragState.clientName;
                if (overflow) {
                  ghostState = "overflow";
                  ghostLabel = labels.overflowMessage;
                } else if (conflict) {
                  ghostState = "conflict";
                  ghostLabel = labels.conflictWith(conflict.client_name);
                }
                // Floating time pill above the ghost — always legible regardless
                // of block width. Emerald + 🧲 when locked flush back-to-back.
                const pillLeft = Math.max(0, Math.min(leftPx, timelineWidthPx - 150));
                const pillText = overflow
                  ? labels.overflowMessage
                  : `${flush ? "🧲 " : ""}${targetTimeLabel} → ${endTimeLabel}`;
                dragGhostEl = (
                  <>
                    <GhostBlock
                      leftPx={leftPx}
                      widthPx={widthPx}
                      state={ghostState}
                      flush={flush}
                      label={ghostLabel}
                    />
                    <div
                      className={cn(
                        "pointer-events-none absolute top-1 z-40 flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-bold shadow-lg backdrop-blur-sm transition-[left] duration-150 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
                        flush
                          ? "border-emerald-400/70 bg-emerald-500/90 text-white shadow-[0_4px_16px_-2px_rgba(16,185,129,0.7)]"
                          : ghostState === "conflict" || ghostState === "overflow"
                            ? "border-nq-error/60 bg-nq-error/90 text-white"
                            : "border-nq-primary/60 bg-nq-bg/95 text-nq-primary shadow-[0_4px_16px_-4px_rgba(212,175,55,0.6)]",
                      )}
                      style={{ left: pillLeft }}
                    >
                      {pillText}
                    </div>
                  </>
                );
              }

              const showGhost =
                assignMode &&
                assigning !== null &&
                hoveredSlot !== null &&
                hoveredSlot.staffId === s.id;

              let ghostEl: ReactNode = null;
              if (showGhost && assigning !== null) {
                const slotIndex = hoveredSlot.slotIndex;
                const slotStartUtc = slotIndexToUtc(
                  slotIndex,
                  selectedDate,
                  timezone,
                  hourStart,
                );
                const spanMinutes = assigning.serviceDurationMinutes;
                const spanEndMs =
                  Date.parse(slotStartUtc) + spanMinutes * 60_000;
                const spanEndIso = new Date(spanEndMs).toISOString();

                const overflowEndMinutesFrom8 =
                  slotIndex * SLOT_MINUTES +
                  spanMinutes -
                  totalSlots * SLOT_MINUTES;
                const overflow = overflowEndMinutesFrom8 > 0;

                const conflict = overflow
                  ? null
                  : checkBookingConflict({
                      staffId: s.id,
                      startUtcIso: slotStartUtc,
                      endUtcIso: spanEndIso,
                      existingBookings: conflictRows,
                    });

                const widthPx = (spanMinutes / SLOT_MINUTES) * SLOT_PX;
                const leftPx = slotIndex * SLOT_PX;

                let state: "ok" | "conflict" | "overflow" = "ok";
                let label = `${assigning.clientName} · ${assigning.serviceDurationMinutes}m`;

                if (overflow) {
                  state = "overflow";
                  label = labels.overflowMessage;
                } else if (conflict) {
                  state = "conflict";
                  label = labels.conflictWith(conflict.client_name);
                }

                ghostEl = (
                  <GhostBlock
                    leftPx={leftPx}
                    widthPx={widthPx}
                    state={state}
                    label={label}
                  />
                );
              }

              // Click-to-create hover preview — a highlighted slot under the
              // pointer PLUS a floating "Staff · time" pill, so the receptionist
              // knows exactly who/when the click books. 15-min sub-slot precision
              // (matches the click), positioned at sub-slot * HALF_PX.
              let createGhostEl: ReactNode = null;
              if (
                clickToCreate &&
                dragState === null && // never alongside the drag ghost
                createHover !== null &&
                createHover.staffId === s.id
              ) {
                const ghostLeft = createHover.leftPx;
                const pillTime = minutesToLabel(createHover.startMin);
                // Label sits INSIDE the cell (top-1), never straddling the row's
                // top edge — the old `-translate-y-1/2` floated it half above the
                // cell, so on the first staff row / when the grid scroll clips
                // overflow it got cut off. Also clamp `left` so a slot near the
                // right edge doesn't push the pill off-screen. Right-anchor the
                // text when it would overflow so it grows leftwards into view.
                const PILL_W = 132;
                const wouldOverflowRight =
                  ghostLeft + PILL_W > timelineWidthPx;
                const pillLeft = wouldOverflowRight
                  ? Math.max(0, ghostLeft + SLOT_PX - PILL_W)
                  : ghostLeft + 2;
                createGhostEl = (
                  <>
                    <GhostBlock
                      leftPx={ghostLeft}
                      widthPx={SLOT_PX}
                      state="ok"
                      label=""
                    />
                    <div
                      data-testid="create-booking-preview"
                      className="pointer-events-none absolute top-1 z-30 flex items-center gap-1 whitespace-nowrap rounded-full border border-nq-primary/50 bg-nq-bg/90 px-2 py-0.5 text-[11px] font-semibold text-nq-primary shadow-nq-card ring-1 ring-nq-primary/20 backdrop-blur-sm"
                      style={{ left: pillLeft }}
                    >
                      <span aria-hidden className="text-nq-primary/90">＋</span>
                      <span>{pillTime}</span>
                      <span className="font-normal text-nq-primary/70">· {s.name}</span>
                    </div>
                  </>
                );
              }

              return (
                <div
                  key={s.id}
                  className={cn(
                    "relative border-b border-nq-muted/15 transition-colors",
                    assignMode && "cursor-copy",
                    clickToCreate &&
                      (blockedCreateHoverStaffId === s.id
                        ? "cursor-not-allowed"
                        : "cursor-pointer"),
                    // Highlight the row the click-to-create pointer is over.
                    clickToCreate &&
                      createHover?.staffId === s.id &&
                      "bg-nq-primary/[0.05]",
                  )}
                  style={{ height: ROW_HEIGHT, width: timelineWidthPx }}
                  onMouseLeave={() => {
                    setHoveredSlot(null);
                    setCreateHover(null);
                    setBlockedCreateHoverStaffId(null);
                  }}
                  onMouseMove={
                    clickToCreate
                      ? (e: MouseEvent<HTMLDivElement>) => {
                          // While a block is being dragged, suppress the
                          // click-to-create hover preview — otherwise BOTH the
                          // drag ghost and the create ghost render at once and
                          // overlap as two translucent layers.
                          if (dragState !== null) {
                            if (createHover !== null) setCreateHover(null);
                            setBlockedCreateHoverStaffId(null);
                            return;
                          }
                          const rowRect =
                            e.currentTarget.getBoundingClientRect();
                          const res = resolveCreateStart(
                            e.clientX - rowRect.left,
                          );
                          if (!res) {
                            if (createHover?.staffId === s.id)
                              setCreateHover(null);
                            setBlockedCreateHoverStaffId(s.id);
                            return;
                          }
                          setBlockedCreateHoverStaffId(null);
                          if (
                            createHover?.staffId !== s.id ||
                            createHover.startMin !== res.startMin
                          ) {
                            setCreateHover({
                              staffId: s.id,
                              startMin: res.startMin,
                              leftPx: res.leftPx,
                            });
                          }
                        }
                      : undefined
                  }
                  // Click-to-create at the ROW level (replaces the per-slot
                  // button path removed in this fix). A click anywhere on the
                  // row that lands on a genuinely empty + creatable slot opens
                  // the prefilled booking form. Clicks on a real booking block
                  // bubble up here too, but the booking-overlap gate below
                  // returns early so the block's own onClick (open drawer) is
                  // the only action — no double-fire.
                  onClick={
                    clickToCreate && onEmptySlotClick
                      ? (e: MouseEvent<HTMLDivElement>) => {
                          // Swallow the spurious click that fires right after a
                          // completed drag (matches the BookingBlock guard).
                          if (recentlyDraggedRef.current) return;
                          const rowRect =
                            e.currentTarget.getBoundingClientRect();
                          // Same resolver as the hover preview — snaps to the
                          // 15-min grid, or to a preceding booking's exact end
                          // for a back-to-back start. Returns null over a booking
                          // body / off-hours / offline staff (no create).
                          const res = resolveCreateStart(
                            e.clientX - rowRect.left,
                          );
                          if (!res) return;
                          const timeLabel = minutesToLabel(res.startMin);
                          onEmptySlotClick(s.id, selectedDate, timeLabel, {
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }
                      : undefined
                  }
                >
                  <div className="pointer-events-none absolute inset-0 flex">
                    {Array.from({ length: totalSlots }, (_, i) => (
                      <div
                        key={i}
                        className={cn(
                          "h-full border-l",
                          showTimelineHeatmap
                            ? i % 2 === 0
                              ? "border-nq-muted/18"
                              : "border-nq-muted/8"
                            : i % 2 === 0
                              ? "border-nq-muted/10"
                              : "border-transparent",
                        )}
                        style={{ width: SLOT_PX, flexShrink: 0 }}
                      />
                    ))}
                  </div>

                  <div
                    className={cn(
                      "absolute inset-0 flex",
                      assignMode
                        ? // Assign mode: buttons sit ABOVE booking blocks
                          // (z-[3] > block z-[2]) so any slot — even one
                          // visually under a block — can receive the
                          // walk-in assignment click. Unchanged behavior.
                          "z-[3]"
                        : // Non-assign (click-to-create OR plain desk): this
                          // slot-button layer is FULLY INERT. Click-to-create
                          // is handled at the row level instead, and the
                          // booking-block layer above keeps its native
                          // pointer-events so drag-to-reschedule works exactly
                          // as before #393. The buttons stay rendered (E2E
                          // `assign-slot-*` + `data-slot-utc` rely on them) but
                          // pointer-events-none guarantees they never swallow a
                          // click intended for a booking block or the row.
                          "z-[1] pointer-events-none",
                    )}
                  >
                    {Array.from({ length: totalSlots }, (_, slotIndex) => {
                      // The slot's absolute UTC start, reused from the memoized
                      // slotUtcList (NOT recomputed per render — the grid
                      // re-renders each second while the undo countdown ticks).
                      // Also exposed as `data-slot-utc` so E2E can target a slot
                      // by wall-clock time rather than by index (the index↔time
                      // mapping shifts as computeHourRange widens to include now).
                      const slotUtc = slotUtcList[slotIndex]!;
                      // These slot buttons are ONLY interactive in assign mode
                      // (walk-in assignment). Click-to-create no longer routes
                      // through them — it's handled at the row level — so the
                      // wrapper above is pointer-events-none outside assign
                      // mode. The buttons are still rendered (E2E targets
                      // `assign-slot-*` / `data-slot-utc`) but inert.
                      const interactive = assignMode;
                      return (
                        <button
                          key={slotIndex}
                          type="button"
                          data-testid={`assign-slot-${s.id}-${slotIndex}`}
                          data-slot-utc={slotUtc}
                          tabIndex={interactive ? 0 : -1}
                          aria-hidden={!interactive}
                          // Discernible text for a11y: in assign mode the empty
                          // button is visually opacity-0 with no children, so
                          // give it the slot time as its accessible name (axe
                          // button-name).
                          aria-label={
                            interactive
                              ? labels.formatTimeLabel(slotUtc)
                              : undefined
                          }
                          className={cn(
                            "h-full shrink-0 border-0 bg-transparent p-0 opacity-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-nq-primary/50",
                            assignMode ? "cursor-copy pointer-events-auto" : "",
                          )}
                          style={{ width: SLOT_PX }}
                          onMouseEnter={
                            assignMode
                              ? () =>
                                  setHoveredSlot({ staffId: s.id, slotIndex })
                              : undefined
                          }
                          onFocus={
                            assignMode
                              ? () =>
                                  setHoveredSlot({ staffId: s.id, slotIndex })
                              : undefined
                          }
                          onClick={(e: MouseEvent) => {
                            if (!assignMode) return;
                            e.stopPropagation();
                            onSlotClick(s.id, slotUtc);
                          }}
                          onKeyDown={(e: KeyboardEvent) => {
                            if (!assignMode) return;
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            onSlotClick(s.id, slotUtc);
                          }}
                        />
                      );
                    })}
                  </div>

                  <div
                    className={cn(
                      "relative h-full z-[2]",
                      // Only ASSIGN mode makes this wrapper pointer-transparent
                      // so empty space falls through to the assign-button layer
                      // (z-[3]) above. In click-to-create / plain desk mode the
                      // wrapper stays interactive (restored to pre-#393
                      // behavior) so booking blocks drag normally; empty-space
                      // clicks are caught by the row-level onClick instead.
                      assignMode && "pointer-events-none",
                    )}
                  >
                    {rowBookings.map((b) => {
                      const { leftPx, widthPx, bufferWidthPx } =
                        bookingToPosition(b, timezone, hourStart);
                      const endMs = Date.parse(b.end_time_utc);
                      const nowMs = Date.parse(nowIso);
                      const isLate =
                        b.status === "in_progress" &&
                        Number.isFinite(endMs) &&
                        Number.isFinite(nowMs) &&
                        endMs < nowMs;
                      // Lateness tier for confirmed/pending past start time.
                      const { tier: latenessTier, autoAtIso } =
                        computeLatenessTier({
                          status: b.status,
                          startTimeUtc: b.start_time_utc,
                          nowIso,
                          autoNoShowMinutes: autoNoShowMinutes ?? null,
                        });
                      const autoNoShowAtLabel = autoAtIso
                        ? labels.formatTimeLabel(autoAtIso)
                        : undefined;
                      const isDraggable =
                        !!onRescheduleBooking &&
                        !assignMode &&
                        (b.status === "pending" || b.status === "confirmed");
                      const isBeingDragged = dragState?.bookingId === b.id;
                      return (
                        <BookingBlock
                          key={b.id}
                          bookingId={b.id}
                          clientName={displayCustomerName(
                            b.client_name,
                            labels.removedGuest,
                          )}
                          serviceName={b.service_name}
                          status={b.status}
                          source={b.source}
                          sourceChannel={b.source_channel ?? b.source}
                          startTimeLabel={labels.formatTimeLabel(
                            b.start_time_utc,
                          )}
                          endTimeLabel={labels.formatTimeLabel(b.end_time_utc)}
                          priceCents={b.price_cents}
                          currencyCode={currencyCode}
                          leftPx={leftPx}
                          widthPx={widthPx}
                          bufferWidthPx={bufferWidthPx}
                          bufferMinutes={b.buffer_minutes ?? 0}
                          onClick={
                            isBeingDragged
                              ? undefined
                              : () => {
                                  // Guard against the spurious click that fires
                                  // after a completed drag on some browsers.
                                  if (recentlyDraggedRef.current) return;
                                  onBookingClick(b.id);
                                }
                          }
                          showPrice={showBookingPrices}
                          showMetaLine={showBookingMetaLine}
                          showTimeRange={showBookingTimeRange}
                          showWalkinAccent={showWalkinAccent}
                          minHeightPx={bookingBlockMinHeightPx}
                          isVip={b.is_vip}
                          hasNotes={b.has_notes}
                          hasDesign={b.has_design}
                          hasStaffRequest={b.has_staff_request}
                          addonCount={b.addon_count ?? 0}
                          noShowCount={b.no_show_count ?? 0}
                          noShowRiskScore={b.no_show_risk_score ?? null}
                          noShowCandidate={b.no_show_candidate_at != null}
                          isGroup={b.group_id != null}
                          groupId={b.group_id ?? null}
                          seatTogether={b.seat_together === true}
                          compactIcons={compactBookingIcons}
                          isLate={isLate}
                          iconLabels={labels.bookingIcon}
                          resourceName={b.resource_name}
                          afterHoursMinutes={b.after_hours_minutes}
                          isDragging={isBeingDragged}
                          latenessTier={latenessTier}
                          autoNoShowAtLabel={autoNoShowAtLabel}
                          onStart={
                            onStartBooking !== undefined &&
                            latenessTier !== null
                              ? () => onStartBooking(b.id)
                              : undefined
                          }
                          onPointerDown={
                            isDraggable
                              ? (e) => {
                                  if (e.button !== 0) return;
                                  // No preventDefault — let the click event fire
                                  // normally if the pointer doesn't move past
                                  // DRAG_THRESHOLD_PX. The global pointermove
                                  // handler promotes this to a real drag only
                                  // after the threshold is exceeded.
                                  const blockRect =
                                    e.currentTarget.getBoundingClientRect();
                                  const grabOffsetPx = Math.max(
                                    0,
                                    e.clientX - blockRect.left,
                                  );
                                  const staffIdx = staffRef.current.findIndex(
                                    (st) => st.id === b.staff_id,
                                  );
                                  const durationMinutes =
                                    (Date.parse(b.end_time_utc) -
                                      Date.parse(b.start_time_utc)) /
                                    60_000;
                                  const startMin =
                                    utcIsoToSalonMinutesFromMidnight(
                                      b.start_time_utc,
                                      timezone,
                                    );
                                  const slotIdx = Math.round(
                                    (startMin - hourStart * 60) / SLOT_MINUTES,
                                  );
                                  pendingDragRef.current = {
                                    bookingId: b.id,
                                    serviceId: b.service_id,
                                    staffId: b.staff_id,
                                    startUtc: b.start_time_utc,
                                    durationMinutes,
                                    clientName: b.client_name,
                                    startX: e.clientX,
                                    startY: e.clientY,
                                    grabOffsetPx,
                                    initialStaffIdx: Math.max(0, staffIdx),
                                    initialSlotIdx: Math.max(0, slotIdx),
                                  };
                                }
                              : undefined
                          }
                        />
                      );
                    })}
                    {/* No-show tombstones — thin dashed ribbons at the bottom of the row
                        for each no-show booking that belonged to this staff member. */}
                    {(noShowTombstones ?? [])
                      .filter((t) => t.staffId === s.id)
                      .map((t) => {
                        const startMin = utcIsoToSalonMinutesFromMidnight(
                          t.startTimeUtc,
                          timezone,
                        );
                        const minutesFromStart = startMin - hourStart * 60;
                        const durationMin =
                          (Date.parse(t.endTimeUtc) -
                            Date.parse(t.startTimeUtc)) /
                          60_000;
                        const tLeftPx =
                          (minutesFromStart / SLOT_MINUTES) * SLOT_PX;
                        const tWidthPx =
                          (durationMin / SLOT_MINUTES) * SLOT_PX;
                        const canCharge =
                          t.hasCard &&
                          t.feeCents !== null &&
                          t.feeCents > 0 &&
                          t.chargeStatus !== "charged" &&
                          t.chargeStatus !== "waived";
                        return (
                          <NoShowTombstone
                            key={t.id}
                            id={t.id}
                            clientName={t.clientName}
                            leftPx={tLeftPx}
                            widthPx={tWidthPx}
                            feeCents={t.feeCents}
                            chargeStatus={t.chargeStatus}
                            hasCard={t.hasCard}
                            language={language}
                            currencyCode={currencyCode}
                            onUndo={
                              onTombstoneUndo
                                ? () => onTombstoneUndo(t.id)
                                : undefined
                            }
                            onCharge={
                              canCharge
                                ? () => onTombstoneCharge?.(t.id)
                                : undefined
                            }
                            onWaive={
                              canCharge
                                ? () => onTombstoneWaive?.(t.id)
                                : undefined
                            }
                          />
                        );
                      })}
                    {/* Soft waitlist-offer markers — a cancelled booking's freed
                        slot is being texted to a waiting online customer (20-min
                        claim window), so the cell looks empty. A dashed amber
                        ribbon tells staff "đang mời khách chờ" so they don't give
                        it to a walk-in. `pointer-events-none` is CRITICAL: the
                        empty cell underneath must stay clickable so staff can
                        still override the soft hold. */}
                    {(waitlistOffers ?? [])
                      .filter((o) => o.staffId === s.id)
                      .map((o) => {
                        const startMin = utcIsoToSalonMinutesFromMidnight(
                          o.startUtc,
                          timezone,
                        );
                        const leftPx =
                          ((startMin - hourStart * 60) / SLOT_MINUTES) *
                          SLOT_PX;
                        const widthPx =
                          ((Date.parse(o.endUtc) - Date.parse(o.startUtc)) /
                            60000 /
                            SLOT_MINUTES) *
                          SLOT_PX;
                        const expiryTime = labels.formatTimeLabel(
                          o.expiresAtUtc,
                        );
                        const title =
                          labels.waitlistOffer ??
                          (language === "vi"
                            ? "Đang mời khách chờ"
                            : "Offering to waitlist");
                        const untilLabel = labels.waitlistOfferUntil
                          ? labels.waitlistOfferUntil(expiryTime)
                          : language === "vi"
                            ? `đến ${expiryTime}`
                            : `until ${expiryTime}`;
                        return (
                          <div
                            key={o.id}
                            className="pointer-events-none absolute inset-y-0 z-[1] flex items-center overflow-hidden rounded-md border border-dashed border-nq-primary/50 bg-nq-primary/10 px-1"
                            style={{ left: leftPx, width: widthPx }}
                            aria-hidden
                          >
                            <span className="truncate text-[10px] leading-tight text-nq-primary">
                              ⏳ {title} · {untilLabel}
                            </span>
                          </div>
                        );
                      })}
                    {ghostEl}
                    {createGhostEl}
                    {dragGhostEl}
                  </div>
                </div>
              );
            })}
            {/* eslint-enable react-hooks/refs */}

            <div
              className="pointer-events-none absolute inset-0 z-[8]"
              aria-hidden
            >
              {/* Closing-time marker. A muted dashed gridline at the salon's
                  close time + a faint shaded "closed" band to its right (the
                  band only has width when an off-hours booking widened the
                  window past close). Static + muted so it never competes with
                  the red, pulsing NOW line. */}
              {closingLeftPx !== null ? (
                <>
                  <div
                    className="absolute inset-y-0 z-[7] bg-nq-muted/10"
                    style={{ left: closingLeftPx, right: 0 }}
                  />
                  <div
                    className="absolute inset-y-0 z-[9] w-px"
                    style={{
                      left: closingLeftPx,
                      backgroundImage:
                        "repeating-linear-gradient(to bottom, var(--color-nq-muted) 0 4px, transparent 4px 8px)",
                    }}
                  />
                </>
              ) : null}
              {/* Time bubble is rendered separately in the time-header strip
                  above so it stays vertically sticky during vertical scroll;
                  this NowLine renders only the vertical line itself. */}
              <NowLine leftPx={nowLineLeftPx} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── NoShowTombstone ─────────────────────────────────────────────────────────
// Grid-specific thin ribbon pinned to the bottom of a staff row for no-show
// bookings. Shows dashed red stripes and opens a popover on click with
// undo / charge / waive actions.

interface NoShowTombstoneProps {
  id: string;
  clientName: string;
  leftPx: number;
  widthPx: number;
  feeCents: number | null;
  chargeStatus: string | null;
  hasCard: boolean;
  language: "en" | "vi";
  currencyCode?: import("@/shared/lib/currencyFormat").Currency;
  onUndo?: () => void;
  onCharge?: () => void;
  onWaive?: () => void;
}

function NoShowTombstone({
  id,
  clientName,
  leftPx,
  widthPx,
  feeCents,
  chargeStatus,
  hasCard,
  language,
  currencyCode,
  onUndo,
  onCharge,
  onWaive,
}: NoShowTombstoneProps) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const vi = language === "vi";

  // Click-away: close when pointer lands outside the popover.
  useEffect(() => {
    if (!open) return;
    const handle = (e: PointerEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handle);
    return () => document.removeEventListener("pointerdown", handle);
  }, [open]);

  // Derive status label and color.
  const amountStr = feeCents ? (formatCurrency(feeCents, currencyCode) ?? "") : "";
  let statusLabel: string;
  let statusClass: string;
  if (chargeStatus === "charged") {
    statusLabel = vi ? `Đã thu ${amountStr}` : `Charged ${amountStr}`;
    statusClass = "text-nq-success";
  } else if (chargeStatus === "waived") {
    statusLabel = vi ? "Đã bỏ qua" : "Waived";
    statusClass = "text-nq-muted";
  } else if (chargeStatus === "failed") {
    statusLabel = vi ? "Thu phí thất bại" : "Charge failed";
    statusClass = "text-nq-warning";
  } else if (
    hasCard &&
    feeCents &&
    feeCents > 0 &&
    chargeStatus !== "charged" &&
    chargeStatus !== "waived"
  ) {
    statusLabel = vi
      ? `Chưa thu ${amountStr} — bấm để thu`
      : `Unpaid ${amountStr} — tap to charge`;
    statusClass = "text-nq-error";
  } else {
    statusLabel = vi ? "Vắng mặt" : "No-show";
    statusClass = "text-nq-muted";
  }

  return (
    <div
      className="pointer-events-auto absolute bottom-0 h-3.5 cursor-pointer rounded border border-dashed border-nq-error/50 bg-nq-error/10"
      style={{
        left: leftPx,
        width: Math.max(8, widthPx - 4),
        backgroundImage:
          "repeating-linear-gradient(45deg, rgba(239,68,68,0.25) 0, rgba(239,68,68,0.25) 2px, transparent 2px, transparent 6px)",
        zIndex: 1,
      }}
      aria-label={vi ? `Khách vắng: ${clientName}` : `No-show: ${clientName}`}
      data-testid={`noshow-tombstone-${id}`}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((p) => !p);
      }}
    >
      {open ? (
        <div
          ref={popoverRef}
          className="absolute bottom-full left-0 z-50 min-w-48 rounded-xl border border-nq-border/60 bg-nq-surface p-2.5 shadow-nq-card"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Client name + status */}
          <div className="mb-2 flex items-start gap-2">
            <span className="flex-1 truncate text-sm font-semibold text-nq-foreground">
              {clientName}
            </span>
            <span className={`shrink-0 text-xs ${statusClass}`}>
              {statusLabel}
            </span>
          </div>

          {/* Action buttons */}
          {onUndo ? (
            <button
              type="button"
              className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-nq-success transition-colors hover:bg-nq-surface/80"
              onClick={() => {
                setOpen(false);
                onUndo();
              }}
            >
              {vi ? "Bỏ vắng (đã đến)" : "Undo no-show"}
            </button>
          ) : null}
          {onCharge ? (
            <button
              type="button"
              className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-nq-warning transition-colors hover:bg-nq-surface/80"
              onClick={() => {
                setOpen(false);
                onCharge();
              }}
            >
              {vi ? `Thu phí ${amountStr}` : `Charge ${amountStr}`}
            </button>
          ) : null}
          {onWaive ? (
            <button
              type="button"
              className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-nq-muted transition-colors hover:bg-nq-surface/80"
              onClick={() => {
                setOpen(false);
                onWaive();
              }}
            >
              {vi ? "Bỏ qua phí" : "Waive fee"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `React.memo` skip — the parent re-renders every minute as `nowIso`
 * ticks, but most of those re-renders carry referentially-stable props
 * because the parent already memoizes `gridStaff`, `gridBookings`, and
 * the `labels` object. The shallow prop check here lets the timeline
 * skip the heavy slot-grid + booking-block render whenever the only
 * change is unrelated parent state (e.g. drawer open/close, undo toast
 * countdown, sound-unlock hint). Callbacks (`onBookingClick`,
 * `onSlotClick`) are recreated each render in the parent — that's a
 * known limitation; wrapping them in `useCallback` is the next
 * incremental win if profiling shows wasted renders here.
 */
export const StaffTimelineGrid = memo(StaffTimelineGridImpl);
