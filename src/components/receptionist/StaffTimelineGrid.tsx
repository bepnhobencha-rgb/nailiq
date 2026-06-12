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

import { BookingBlock } from "./BookingBlock";
import { GhostBlock } from "./GhostBlock";
import { NowLine } from "./NowLine";
import { StaffAvatar, type StaffStatus } from "@/components/ui/StaffAvatar";
import { checkBookingConflict, type ConflictCheckBooking } from "@/shared/lib/conflictCheck";
import { cn } from "@/shared/lib/cn";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import {
  salonNowMinutes,
  salonWallTimeToUtcIso,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";
import { minutesToLabel } from "@/shared/booking/getAvailableTimeSlots";

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
  /** Client's lifetime no-show count — drives a ⚠ chip badge for repeat offenders. */
  no_show_count?: number;
  /** AI no-show risk score (0–100) — drives an amber risk ⚠ on the block. */
  no_show_risk_score?: number | null;
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
  onEmptySlotClick?: (staffId: string, ymd: string, timeLabel: string) => void;
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
  const startMin = utcIsoToSalonMinutesFromMidnight(booking.start_time_utc, timezone);
  const minutesFromStart = startMin - hourStart * 60;
  const durationMin =
    (Date.parse(booking.end_time_utc) - Date.parse(booking.start_time_utc)) / 60_000;
  return {
    leftPx: (minutesFromStart / SLOT_MINUTES) * SLOT_PX,
    widthPx: (durationMin / SLOT_MINUTES) * SLOT_PX,
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
    const startMin = utcIsoToSalonMinutesFromMidnight(b.start_time_utc, timezone);
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
      startH = Math.min(startH, Math.floor(m / 60));
      // +1 slot so "now" near the hour edge still has a column to its right.
      endH = Math.max(endH, Math.ceil((m + SLOT_MINUTES) / 60));
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
  targetSlotIdx: number;
}

function StaffTimelineGridImpl({
  staff,
  bookings,
  assigning,
  selectedDate,
  openMinutes,
  closeMinutes,
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
          setDragState({
            bookingId: pending.bookingId,
            serviceId: pending.serviceId,
            originalStaffId: pending.staffId,
            originalStartUtc: pending.startUtc,
            durationMinutes: pending.durationMinutes,
            grabOffsetPx: pending.grabOffsetPx,
            clientName: pending.clientName,
            targetStaffIdx: pending.initialStaffIdx,
            targetSlotIdx: pending.initialSlotIdx,
          });
        }
        return;
      }

      if (!ds || !scroll) return;

      const rect = scroll.getBoundingClientRect();
      const relX = e.clientX - rect.left - STAFF_COL_WIDTH + scroll.scrollLeft;
      const relY = e.clientY - rect.top - TIME_HEADER_HEIGHT + scroll.scrollTop;

      const slotIdx = Math.max(
        0,
        Math.min(
          totalSlotsRef.current - 1,
          Math.round((relX - ds.grabOffsetPx) / SLOT_PX),
        ),
      );
      const staffIdx = Math.max(
        0,
        Math.min(staffRef.current.length - 1, Math.floor(relY / ROW_HEIGHT)),
      );

      setDragState((prev) =>
        prev && (prev.targetSlotIdx !== slotIdx || prev.targetStaffIdx !== staffIdx)
          ? { ...prev, targetSlotIdx: slotIdx, targetStaffIdx: staffIdx }
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
      const slotStartUtc = slotIndexToUtc(
        ds.targetSlotIdx,
        selectedDateRef.current,
        timezoneRef.current,
        hourStartRef.current,
      );

      const noChange =
        targetStaff?.id === ds.originalStaffId &&
        slotStartUtc === ds.originalStartUtc;

      if (!noChange && targetStaff && onRescheduleRef.current) {
        void onRescheduleRef.current(ds.bookingId, targetStaff.id, slotStartUtc);
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

  const bookingsByStaff = useMemo(() => {
    const m = new Map<string, GridBooking[]>();
    for (const b of bookings) {
      const list = m.get(b.staff_id) ?? [];
      list.push(b);
      m.set(b.staff_id, list);
    }
    return m;
  }, [bookings]);

  const nowLineLeftPx = useMemo(() => {
    if (!isViewingToday) return null;
    return computeNowLineLeftPx(nowIso, timezone, hourStart, hourEnd);
  }, [isViewingToday, nowIso, timezone, hourStart, hourEnd]);

  const nowLineLabel = useMemo(() => labels.formatTimeLabel(nowIso), [labels, nowIso]);

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
  }, [isViewingToday, nowIso, timezone, selectedDate, hourStart, hourEnd, totalSlots]);

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
  }, [jumpToNowTrigger, isViewingToday, nowIso, timezone, hourStart, hourEnd, totalSlots]);

  const assignMode = assigning !== null;
  // Click-to-create is active when we're NOT assigning a walk-in AND the
  // parent wired a handler. In this mode clicking a genuinely empty slot
  // opens the desk booking form prefilled. Mutually exclusive with assign.
  const clickToCreate = !assignMode && !!onEmptySlotClick;

  // Slot-validity check for click-to-create only — does NOT affect assign
  // mode (assign keeps its original "any slot clickable" behavior). A slot
  // is creatable when the staff row is active (not "offline") AND the slot
  // start time is within the salon's open/close window (skip the hours
  // guard when either bound is null/unknown).
  const isSlotCreatable = (staffStatus: StaffStatus, slotIndex: number): boolean => {
    if (staffStatus === "offline") return false;
    const slotMinutes = hourStart * 60 + slotIndex * SLOT_MINUTES;
    if (openMinutes != null && slotMinutes < openMinutes) return false;
    if (closeMinutes != null && slotMinutes >= closeMinutes) return false;
    return true;
  };

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
            "sticky left-0 z-[15] flex shrink-0 flex-col border-r border-nq-muted/25 bg-nq-bg",
          )}
        >
          <div
            className="sticky top-0 z-[25] shrink-0 bg-nq-bg"
            style={{ width: STAFF_COL_WIDTH, height: TIME_HEADER_HEIGHT }}
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
                <p className="truncate text-sm font-semibold text-nq-foreground">{s.name}</p>
                {showStaffPerformanceDetail ? (
                  <p className="truncate text-[11px] text-nq-muted">{s.job_role}</p>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col" style={{ width: timelineWidthPx }}>
          <div
            className={cn(
              "sticky top-0 z-12 flex shrink-0 bg-nq-bg/95 backdrop-blur-sm",
              // `relative` anchors the floating NOW-time bubble (below)
              // inside the time-header strip; combined with the strip's
              // existing `sticky top-0` this keeps the bubble visible
              // during VERTICAL scroll, while it scrolls horizontally
              // with the timeline (i.e. tied to the NOW position on
              // the time axis).
              "relative",
            )}
            style={{ height: TIME_HEADER_HEIGHT, width: timelineWidthPx }}
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
                aria-label={`Current time ${nowLineLabel}`}
              >
                {nowLineLabel}
              </div>
            ) : null}
          </div>

          <div
            className="relative"
            style={{ height: staff.length * ROW_HEIGHT, width: timelineWidthPx }}
          >
            {/* eslint-disable react-hooks/refs -- ARCHITECTURE_LOCK: staffRef.current accessed during render for drag-ghost target lookup; stable-ref pattern */}
            {staff.map((s) => {
              const rowBookings = bookingsByStaff.get(s.id) ?? [];
              // Drag-to-reschedule ghost — shown when a booking block is being dragged.
              const isDragTarget =
                dragState !== null &&
                staffRef.current[dragState.targetStaffIdx]?.id === s.id;
              let dragGhostEl: ReactNode = null;
              if (isDragTarget && dragState !== null) {
                const slotStartUtc = slotIndexToUtc(
                  dragState.targetSlotIdx,
                  selectedDate,
                  timezone,
                  hourStart,
                );
                const spanEndMs =
                  Date.parse(slotStartUtc) + dragState.durationMinutes * 60_000;
                const spanEndIso = new Date(spanEndMs).toISOString();
                const widthPx = (dragState.durationMinutes / SLOT_MINUTES) * SLOT_PX;
                const leftPx = dragState.targetSlotIdx * SLOT_PX;
                const overflowMin =
                  dragState.targetSlotIdx * SLOT_MINUTES +
                  dragState.durationMinutes -
                  totalSlots * SLOT_MINUTES;
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
                let ghostState: "ok" | "conflict" | "overflow" = "ok";
                let ghostLabel = `${dragState.clientName}`;
                if (overflow) {
                  ghostState = "overflow";
                  ghostLabel = labels.overflowMessage;
                } else if (conflict) {
                  ghostState = "conflict";
                  ghostLabel = labels.conflictWith(conflict.client_name);
                }
                dragGhostEl = (
                  <GhostBlock
                    leftPx={leftPx}
                    widthPx={widthPx}
                    state={ghostState}
                    label={ghostLabel}
                  />
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
                const spanEndMs = Date.parse(slotStartUtc) + spanMinutes * 60_000;
                const spanEndIso = new Date(spanEndMs).toISOString();

                const overflowEndMinutesFrom8 =
                  slotIndex * SLOT_MINUTES + spanMinutes - totalSlots * SLOT_MINUTES;
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
                  <GhostBlock leftPx={leftPx} widthPx={widthPx} state={state} label={label} />
                );
              }

              // Click-to-create hover ghost — a single highlighted slot under
              // the pointer. We don't know the service duration yet, so it's
              // just a 1-slot cue (not a duration-sized span). Only shown for
              // a creatable empty slot in click-to-create mode.
              let createGhostEl: ReactNode = null;
              if (
                clickToCreate &&
                hoveredSlot !== null &&
                hoveredSlot.staffId === s.id &&
                isSlotCreatable(s.status, hoveredSlot.slotIndex)
              ) {
                createGhostEl = (
                  <GhostBlock
                    leftPx={hoveredSlot.slotIndex * SLOT_PX}
                    widthPx={SLOT_PX}
                    state="ok"
                    label=""
                  />
                );
              }

              return (
                <div
                  key={s.id}
                  className={cn(
                    "relative border-b border-nq-muted/15",
                    assignMode && "cursor-copy",
                  )}
                  style={{ height: ROW_HEIGHT, width: timelineWidthPx }}
                  onMouseLeave={() => setHoveredSlot(null)}
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
                        : clickToCreate
                          ? // Click-to-create: buttons must sit BELOW the
                            // booking-block layer (z-[1] < block z-[2]) so a
                            // click landing on a real booking hits the block
                            // first (opens drawer / starts drag) and ONLY a
                            // genuinely empty slot reaches the button. The
                            // wrapper still needs pointer-events to let empty
                            // slots receive clicks.
                            "z-[1] pointer-events-auto"
                          : // Fully inert: buttons are aria-hidden/opacity-0
                            // but still real <button>s — pointer-events-none
                            // on the wrapper guarantees they NEVER swallow a
                            // click intended for a booking block above.
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
                      // Click-to-create only: a slot is interactive when the
                      // staff is active and the time is within open hours.
                      // Assign mode ignores this entirely (its behavior is
                      // unchanged below).
                      const creatable =
                        clickToCreate && isSlotCreatable(s.status, slotIndex);
                      // The button is interactive in assign mode (always) or
                      // when click-to-create deems this slot creatable.
                      const interactive = assignMode || creatable;
                      return (
                        <button
                          key={slotIndex}
                          type="button"
                          data-testid={`assign-slot-${s.id}-${slotIndex}`}
                          data-slot-utc={slotUtc}
                          tabIndex={interactive ? 0 : -1}
                          aria-hidden={!interactive}
                          // Discernible text for a11y: when the slot is exposed
                          // (assign or click-to-create), the empty button is
                          // visually opacity-0 with no children, so give it the
                          // slot time as its accessible name (axe button-name).
                          aria-label={interactive ? labels.formatTimeLabel(slotUtc) : undefined}
                          // Disable (visually dim, not clickable) empty slots
                          // that fail the click-to-create validity check —
                          // offline staff or out-of-hours times.
                          disabled={clickToCreate && !creatable}
                          className={cn(
                            "h-full shrink-0 border-0 bg-transparent p-0 opacity-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-nq-primary/50",
                            assignMode ? "cursor-copy pointer-events-auto" : "",
                            // Click-to-create affordances: pointer cursor +
                            // subtle hover wash on creatable empty slots;
                            // not-allowed + dim on blocked ones.
                            creatable &&
                              "cursor-pointer pointer-events-auto hover:bg-nq-primary/10 hover:opacity-100",
                            clickToCreate &&
                              !creatable &&
                              "cursor-not-allowed pointer-events-auto opacity-40",
                          )}
                          style={{ width: SLOT_PX }}
                          onMouseEnter={() =>
                            setHoveredSlot({ staffId: s.id, slotIndex })
                          }
                          onFocus={() => setHoveredSlot({ staffId: s.id, slotIndex })}
                          onClick={(e: MouseEvent) => {
                            if (assignMode) {
                              e.stopPropagation();
                              onSlotClick(s.id, slotUtc);
                              return;
                            }
                            // Click-to-create: only fire on a valid empty slot.
                            if (!creatable || !onEmptySlotClick) return;
                            e.stopPropagation();
                            const minutesFromMidnight =
                              hourStart * 60 + slotIndex * SLOT_MINUTES;
                            const timeLabel = minutesToLabel(minutesFromMidnight);
                            // `selectedDate` is already the salon-local
                            // YYYY-MM-DD (same value fed to slotIndexToUtc).
                            onEmptySlotClick(s.id, selectedDate, timeLabel);
                          }}
                          onKeyDown={(e: KeyboardEvent) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            if (assignMode) {
                              e.preventDefault();
                              onSlotClick(s.id, slotUtc);
                              return;
                            }
                            if (!creatable || !onEmptySlotClick) return;
                            e.preventDefault();
                            const minutesFromMidnight =
                              hourStart * 60 + slotIndex * SLOT_MINUTES;
                            const timeLabel = minutesToLabel(minutesFromMidnight);
                            onEmptySlotClick(s.id, selectedDate, timeLabel);
                          }}
                        />
                      );
                    })}
                  </div>

                  <div
                    className={cn(
                      "relative h-full z-[2]",
                      // Both assign mode AND click-to-create make this wrapper
                      // pointer-transparent so EMPTY space falls through to the
                      // slot-button layer below. The booking blocks inside are
                      // `pointer-events: auto` (CSS default re-enables children),
                      // so clicking a real block still opens the drawer / starts
                      // a drag — only the empty gaps pass through.
                      (assignMode || clickToCreate) && "pointer-events-none",
                    )}
                  >
                    {rowBookings.map((b) => {
                      const { leftPx, widthPx } = bookingToPosition(b, timezone, hourStart);
                      const endMs = Date.parse(b.end_time_utc);
                      const nowMs = Date.parse(nowIso);
                      const isLate =
                        b.status === "in_progress" &&
                        Number.isFinite(endMs) &&
                        Number.isFinite(nowMs) &&
                        endMs < nowMs;
                      const isDraggable =
                        !!onRescheduleBooking &&
                        !assignMode &&
                        (b.status === "pending" || b.status === "confirmed");
                      const isBeingDragged = dragState?.bookingId === b.id;
                      return (
                        <BookingBlock
                          key={b.id}
                          bookingId={b.id}
                          clientName={displayCustomerName(b.client_name, labels.removedGuest)}
                          serviceName={b.service_name}
                          status={b.status}
                          source={b.source}
                          sourceChannel={b.source_channel ?? b.source}
                          startTimeLabel={labels.formatTimeLabel(b.start_time_utc)}
                          endTimeLabel={labels.formatTimeLabel(b.end_time_utc)}
                          priceCents={b.price_cents}
                          currencyCode={currencyCode}
                          leftPx={leftPx}
                          widthPx={widthPx}
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
                          isGroup={b.group_id != null}
                          seatTogether={b.seat_together === true}
                          compactIcons={compactBookingIcons}
                          isLate={isLate}
                          iconLabels={labels.bookingIcon}
                          isDragging={isBeingDragged}
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
                                  const grabOffsetPx =
                                    Math.max(0, e.clientX - blockRect.left);
                                  const staffIdx = staffRef.current.findIndex(
                                    (st) => st.id === b.staff_id,
                                  );
                                  const durationMinutes =
                                    (Date.parse(b.end_time_utc) -
                                      Date.parse(b.start_time_utc)) /
                                    60_000;
                                  const startMin = utcIsoToSalonMinutesFromMidnight(
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
