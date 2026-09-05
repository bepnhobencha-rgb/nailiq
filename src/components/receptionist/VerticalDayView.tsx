"use client";

/**
 * VerticalDayView — mobile-first replacement for StaffTimelineGrid.
 *
 * Renders the day's bookings as a single-axis vertical list (time top-to-bottom).
 * No horizontal scroll. Staff are colour-coded; tap any booking → detail drawer.
 * Swipe left = next day, swipe right = previous day.
 *
 * Rendered only when viewport < 640 px (enforced by the parent, ReceptionistCenter).
 * Desktop always uses StaffTimelineGrid (unchanged).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Play,
  Plus,
} from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import {
  formatInSalonTz,
  salonWallTimeToUtcIso,
} from "@/shared/lib/salonTime";
import { computeLatenessTier } from "./lateness";
import type { GridBooking, GridStaff } from "./StaffTimelineGrid";

// 8-colour palette — one per staff member (by staff list index, stable per session)
const PALETTE = [
  "#F59E0B", // amber
  "#3B82F6", // blue
  "#10B981", // emerald
  "#F43F5E", // rose
  "#8B5CF6", // violet
  "#06B6D4", // cyan
  "#F97316", // orange
  "#A3E635", // lime
] as const;

const SLOT_MIN = 30;
const DEFAULT_OPEN = 8 * 60; // 8:00 AM
const DEFAULT_CLOSE = 20 * 60; // 8:00 PM

const STATUS_DOT: Record<string, string> = {
  pending: "#F59E0B",
  confirmed: "#22C55E",
  in_progress: "#3B82F6",
  completed: "#6B7280",
};

// ─────────────────────────────────── helpers ───────────────────────────────────

function utcToSalonMinutes(utcIso: string, timezone: string): number {
  if (!utcIso) return 0;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(utcIso));
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return (h % 24) * 60 + m;
}

/** Compact label: "9a", "9:30a", "12p", "3:30p" */
function minsToLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const p = h < 12 ? "a" : "p";
  const h12 = h === 0 || h === 24 ? 12 : h > 12 ? h - 12 : h;
  const minStr = m === 0 ? "" : `:${String(m).padStart(2, "0")}`;
  return `${h12}${minStr}${p}`;
}

function minsToDisplayLabel(minutes: number, language: "en" | "vi"): string {
  if (language === "vi") {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return minsToLabel(minutes);
}

/** Add/subtract N calendar days from a YYYY-MM-DD string (UTC arithmetic). */
function addDaysToYmd(ymd: string, delta: number): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d + delta));
  return date.toISOString().slice(0, 10);
}

/**
 * Keep the configured opening-hours window, but widen it to include every
 * rendered booking/tombstone start. The desktop grid already does this for
 * off-hours bookings; mobile must not silently drop the same appointments.
 */
export function computeVerticalSlotWindow(
  openMinutes: number,
  closeMinutes: number,
  itemStartMinutes: number[],
): { start: number; end: number } {
  let start = openMinutes;
  let end = closeMinutes;

  for (const minutes of itemStartMinutes) {
    if (!Number.isFinite(minutes)) continue;
    const slot = Math.floor(minutes / SLOT_MIN) * SLOT_MIN;
    start = Math.min(start, slot);
    end = Math.max(end, slot + SLOT_MIN);
  }

  start = Math.max(0, Math.min(start, 24 * 60 - SLOT_MIN));
  end = Math.min(24 * 60, Math.max(end, start + SLOT_MIN));
  return { start, end };
}

// ──────────────────────────────────── types ────────────────────────────────────

export interface VerticalDayViewProps {
  staff: GridStaff[];
  bookings: GridBooking[];
  selectedDate: string; // YYYY-MM-DD in salon tz
  timezone: string;
  nowIso: string;
  isViewingToday: boolean;
  openMinutes?: number | null;
  closeMinutes?: number | null;
  onBookingClick: (id: string) => void;
  onEmptySlotClick?: (staffId: string, ymd: string, timeLabel: string) => void;
  onNavigateDate: (ymd: string) => void;
  onAddBooking?: () => void;
  onAddWalkin?: () => void;
  onAddGroup?: () => void;
  language?: "en" | "vi";
  autoNoShowMinutes?: number | null;
  currencyCode?: import("@/shared/lib/currencyFormat").Currency;
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
  onStartBooking?: (bookingId: string) => void;
  onTombstoneUndo?: (bookingId: string) => void;
  onTombstoneCharge?: (bookingId: string) => void;
  onTombstoneWaive?: (bookingId: string) => void;
  assigning?: {
    queueItemId: string;
    clientName: string;
    serviceDurationMinutes: number;
  } | null;
  onAssignSlot?: (staffId: string, slotStartUtc: string) => void;
  onCancelAssign?: () => void;
}

// ─────────────────────────────── main component ────────────────────────────────

export default function VerticalDayView({
  staff,
  bookings,
  selectedDate,
  timezone,
  nowIso,
  isViewingToday,
  openMinutes,
  closeMinutes,
  onBookingClick,
  onEmptySlotClick,
  onNavigateDate,
  onAddBooking,
  onAddWalkin,
  onAddGroup,
  language = "en",
  autoNoShowMinutes,
  currencyCode,
  noShowTombstones = [],
  onStartBooking,
  onTombstoneUndo,
  onTombstoneCharge,
  onTombstoneWaive,
  assigning = null,
  onAssignSlot,
  onCancelAssign,
}: VerticalDayViewProps) {
  const open = openMinutes ?? DEFAULT_OPEN;
  const close = closeMinutes ?? DEFAULT_CLOSE;
  const assignMode = assigning !== null && onAssignSlot !== undefined;
  const createMenuRef = useRef<HTMLDetailsElement>(null);

  // Stable colour + name lookup by staff id
  const staffColorMap = useMemo(() => {
    const m: Record<string, string> = {};
    staff.forEach((s, i) => {
      m[s.id] = PALETTE[i % PALETTE.length];
    });
    return m;
  }, [staff]);

  const staffNameMap = useMemo(() => {
    const m: Record<string, string> = {};
    staff.forEach((s) => {
      m[s.id] = s.name;
    });
    return m;
  }, [staff]);

  // Group bookings into 30-min buckets by start time
  const bookingsBySlot = useMemo(() => {
    const map = new Map<number, GridBooking[]>();
    for (const b of bookings) {
      const mins = utcToSalonMinutes(b.start_time_utc, timezone);
      const slot = Math.floor(mins / SLOT_MIN) * SLOT_MIN;
      if (!map.has(slot)) map.set(slot, []);
      map.get(slot)!.push(b);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.start_time_utc.localeCompare(b.start_time_utc));
    }
    return map;
  }, [bookings, timezone]);

  const tombstonesBySlot = useMemo(() => {
    const map = new Map<number, (typeof noShowTombstones)[number][]>();
    for (const tombstone of noShowTombstones) {
      const mins = utcToSalonMinutes(tombstone.startTimeUtc, timezone);
      const slot = Math.floor(mins / SLOT_MIN) * SLOT_MIN;
      if (!map.has(slot)) map.set(slot, []);
      map.get(slot)!.push(tombstone);
    }
    return map;
  }, [noShowTombstones, timezone]);

  // Current-time position for the "now" red line
  const nowMins = useMemo(
    () =>
      isViewingToday && nowIso ? utcToSalonMinutes(nowIso, timezone) : null,
    [isViewingToday, nowIso, timezone],
  );

  // Generate 30-min time slots. Widen around actual items so an appointment
  // before opening or after closing still has a row on the mobile board.
  const slots = useMemo(() => {
    const itemStartMinutes = [
      ...bookings.map((booking) =>
        utcToSalonMinutes(booking.start_time_utc, timezone),
      ),
      ...noShowTombstones.map((tombstone) =>
        utcToSalonMinutes(tombstone.startTimeUtc, timezone),
      ),
    ];
    const window = computeVerticalSlotWindow(open, close, itemStartMinutes);
    const arr: number[] = [];
    for (let m = window.start; m < window.end; m += SLOT_MIN) arr.push(m);
    return arr;
  }, [bookings, close, noShowTombstones, open, timezone]);

  // Horizontal swipe → navigate to prev/next day
  const touchStart = useRef({ x: 0, y: 0 });
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStart.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    };
  }, []);
  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const dx = e.changedTouches[0].clientX - touchStart.current.x;
      const dy = e.changedTouches[0].clientY - touchStart.current.y;
      // Require a clear horizontal swipe (> 60 px, more horizontal than vertical)
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        onNavigateDate(addDaysToYmd(selectedDate, dx < 0 ? 1 : -1));
      }
    },
    [selectedDate, onNavigateDate],
  );

  const addLabel = language === "vi" ? "Tạo" : "Create";

  const runCreateAction = useCallback((action: () => void) => {
    if (createMenuRef.current) createMenuRef.current.open = false;
    action();
  }, []);

  const prevLabel = language === "vi" ? "Hôm qua" : "Prev day";
  const nextLabel = language === "vi" ? "Ngày mai" : "Next day";

  return (
    <div
      className={cn(
        "relative select-none pb-28",
        assignMode ? "cursor-copy" : "",
      )}
      data-testid="vertical-day-view"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Keep date navigation immediately readable; motion on the individual
          controls still provides touch feedback without reducing contrast. */}
      <div className="flex items-center justify-between px-3 pb-2 pt-1">
        <motion.button
          className="flex min-h-11 items-center gap-1 px-2 text-sm text-white/60 active:text-white/80"
          whileTap={{ x: -4 }}
          onClick={() => onNavigateDate(addDaysToYmd(selectedDate, -1))}
          aria-label={prevLabel}
        >
          <ChevronLeft size={14} strokeWidth={2} />
          <span className="tracking-wide">{prevLabel}</span>
        </motion.button>

        <span className="text-xs tracking-widest text-white/60 uppercase">
          {language === "vi" ? "vuốt để đổi ngày" : "swipe to change day"}
        </span>

        <motion.button
          className="flex min-h-11 items-center gap-1 px-2 text-sm text-white/60 active:text-white/80"
          whileTap={{ x: 4 }}
          onClick={() => onNavigateDate(addDaysToYmd(selectedDate, 1))}
          aria-label={nextLabel}
        >
          <span className="tracking-wide">{nextLabel}</span>
          <ChevronRight size={14} strokeWidth={2} />
        </motion.button>
      </div>

      {assignMode ? (
        <div
          data-testid="mobile-walkin-assign-banner"
          className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-xl border border-nq-primary/45 bg-nq-primary/10 px-3 py-2"
        >
          <p className="min-w-0 text-xs font-semibold text-nq-primary">
            {language === "vi" ? "Xếp chỗ cho" : "Assign"}{" "}
            <span className="truncate text-white/90">{assigning.clientName}</span>
            <span className="ml-1 text-white/60">
              · {assigning.serviceDurationMinutes}m
            </span>
          </p>
          {onCancelAssign ? (
            <button
              type="button"
              data-testid="mobile-walkin-assign-cancel"
              className="min-h-9 shrink-0 rounded-lg border border-white/15 px-2.5 text-xs font-semibold text-white/65"
              onClick={onCancelAssign}
            >
              {language === "vi" ? "Hủy" : "Cancel"}
            </button>
          ) : null}
        </div>
      ) : null}

      {slots.map((slot, slotIndex) => {
        const slotBookings = bookingsBySlot.get(slot) ?? [];
        const slotTombstones = tombstonesBySlot.get(slot) ?? [];
        const isHour = slot % 60 === 0;
        const hasItems = slotBookings.length > 0 || slotTombstones.length > 0;

        // Show the "now" red line inside the slot where the current time falls
        const nowLineHere =
          nowMins !== null && nowMins >= slot && nowMins < slot + SLOT_MIN;
        const nowLinePct =
          nowLineHere && nowMins !== null
            ? ((nowMins - slot) / SLOT_MIN) * 100
            : null;

        // Skip empty :30 slots to keep the list tight (only :00 get empty rows)
        if (!assignMode && !hasItems && !isHour && !nowLineHere) return null;

        const slotUtc = salonWallTimeToUtcIso(
          selectedDate,
          slot,
          timezone,
        );

        return (
          <div key={slot} className="relative">
            {/* "Now" red line */}
            {nowLinePct !== null && (
              <div
                className="pointer-events-none absolute left-0 right-0 z-10 flex items-center"
                style={{ top: `${nowLinePct}%` }}
              >
                <div className="h-2 w-2 flex-shrink-0 rounded-full bg-red-500" />
                <div className="h-[1.5px] flex-1 bg-red-500/65" />
              </div>
            )}

            <div
              className={cn(
                "flex gap-3 px-4",
                isHour ? "pb-2 pt-3" : "pb-1 pt-1.5",
              )}
            >
              {/* Time label */}
              <div className="w-12 flex-shrink-0 pt-0.5">
                {isHour ? (
                  <span className="text-base font-semibold tracking-wide text-white/60">
                    {minsToDisplayLabel(slot, language)}
                  </span>
                ) : (
                  <span className="text-sm text-white/60">
                    {minsToDisplayLabel(slot, language)}
                  </span>
                )}
              </div>

              {/* Bookings or empty-slot tap area */}
              <div className="min-w-0 flex-1 space-y-1.5">
                {assignMode ? (
                  <div
                    data-testid={`mobile-assign-slot-${slotIndex}`}
                    className="grid grid-cols-2 gap-1.5"
                  >
                    {staff.map((staffMember) => (
                      <button
                        key={staffMember.id}
                        type="button"
                        data-testid={`assign-slot-${staffMember.id}-${slotIndex}`}
                        data-slot-utc={slotUtc}
                        aria-label={
                          language === "vi"
                            ? `Xếp ${assigning.clientName} cho ${staffMember.name} lúc ${minsToDisplayLabel(slot, language)}`
                            : `Assign ${assigning.clientName} to ${staffMember.name} at ${minsToDisplayLabel(slot, language)}`
                        }
                        className="min-h-11 rounded-lg border border-nq-primary/35 bg-nq-primary/10 px-2 text-left text-xs font-semibold text-white/80 transition-colors active:bg-nq-primary/25"
                        onClick={() => onAssignSlot(staffMember.id, slotUtc)}
                      >
                        <span className="block truncate">{staffMember.name}</span>
                        <span className="text-sm font-normal text-white/60">
                          {minsToDisplayLabel(slot, language)}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {hasItems ? (
                  <>
                    {slotBookings.map((booking) => (
                      <BookingCard
                        key={booking.id}
                        booking={booking}
                        color={staffColorMap[booking.staff_id] ?? "#888"}
                        staffName={staffNameMap[booking.staff_id] ?? ""}
                        timezone={timezone}
                        nowIso={nowIso}
                        autoNoShowMinutes={autoNoShowMinutes ?? null}
                        language={language}
                        onPress={() => onBookingClick(booking.id)}
                        onStart={
                          onStartBooking
                            ? () => onStartBooking(booking.id)
                            : undefined
                        }
                      />
                    ))}
                    {slotTombstones.map((tombstone) => (
                      <MobileNoShowTombstone
                        key={tombstone.id}
                        {...tombstone}
                        language={language}
                        currencyCode={currencyCode}
                        onUndo={
                          onTombstoneUndo
                            ? () => onTombstoneUndo(tombstone.id)
                            : undefined
                        }
                        onCharge={
                          onTombstoneCharge
                            ? () => onTombstoneCharge(tombstone.id)
                            : undefined
                        }
                        onWaive={
                          onTombstoneWaive
                            ? () => onTombstoneWaive(tombstone.id)
                            : undefined
                        }
                      />
                    ))}
                  </>
                ) : !assignMode &&
                  isHour &&
                  (onEmptySlotClick || onAddBooking) ? (
                  <button
                    data-testid={`mobile-empty-slot-${slotIndex}`}
                    className="flex min-h-11 w-full items-center gap-1.5 rounded-lg border border-dashed border-white/40 px-3 text-base text-white/60 transition-colors active:border-white/60 active:text-white/80"
                    onClick={() => {
                      if (onEmptySlotClick && staff.length > 0) {
                        onEmptySlotClick(
                          staff[0].id,
                          selectedDate,
                          minsToLabel(slot),
                        );
                      } else {
                        onAddBooking?.();
                      }
                    }}
                  >
                    <Plus size={11} className="opacity-60" />
                    {minsToDisplayLabel(slot, language)}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}

      {/* One mobile create entry point replaces the duplicate header actions. */}
      {onAddBooking || onAddWalkin || onAddGroup ? (
        <details
          ref={createMenuRef}
          className="group fixed bottom-20 left-4 z-40"
        >
          <summary
            data-testid="mobile-create-menu-trigger"
            className="flex cursor-pointer list-none items-center gap-2 rounded-full bg-nq-primary px-4 py-3 text-base font-semibold text-black shadow-lg transition-transform active:scale-95 [&::-webkit-details-marker]:hidden"
            aria-label={
              language === "vi"
                ? "Tạo lịch hoặc khách vãng lai"
                : "Create booking or walk-in"
            }
          >
            <Plus
              size={16}
              strokeWidth={2.5}
              className="transition-transform group-open:rotate-45"
              aria-hidden
            />
            {addLabel}
          </summary>
          <div className="absolute bottom-full left-0 mb-2 w-56 rounded-2xl border border-white/15 bg-[#181225] p-2 shadow-2xl">
            {onAddWalkin ? (
              <button
                type="button"
                data-testid="mobile-create-walkin"
                onClick={() => runCreateAction(onAddWalkin)}
                className="min-h-11 w-full rounded-xl px-3 text-left text-base font-semibold text-white/90 transition-colors hover:bg-white/10"
              >
                {language === "vi" ? "Khách vãng lai" : "Walk-in customer"}
              </button>
            ) : null}
            {onAddBooking ? (
              <button
                type="button"
                data-testid="mobile-create-appointment"
                onClick={() => runCreateAction(onAddBooking)}
                className="min-h-11 w-full rounded-xl px-3 text-left text-base font-semibold text-white/90 transition-colors hover:bg-white/10"
              >
                {language === "vi" ? "Hẹn mới" : "New appointment"}
              </button>
            ) : null}
            {onAddGroup ? (
              <button
                type="button"
                data-testid="mobile-create-group"
                onClick={() => runCreateAction(onAddGroup)}
                className="min-h-11 w-full rounded-xl px-3 text-left text-base font-semibold text-white/90 transition-colors hover:bg-white/10"
              >
                {language === "vi" ? "Hẹn nhóm" : "Group booking"}
              </button>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

// ──────────────────────────────── booking card ─────────────────────────────────

function BookingCard({
  booking,
  color,
  staffName,
  timezone,
  nowIso,
  autoNoShowMinutes,
  language,
  onPress,
  onStart,
}: {
  booking: GridBooking;
  color: string;
  staffName: string;
  timezone: string;
  nowIso: string;
  autoNoShowMinutes: number | null;
  language: "en" | "vi";
  onPress: () => void;
  onStart?: () => void;
}) {
  const startStr = formatInSalonTz(booking.start_time_utc, timezone, "shortTime");
  const endStr = formatInSalonTz(booking.end_time_utc, timezone, "shortTime");
  const dotColor = STATUS_DOT[booking.status] ?? STATUS_DOT.pending;
  const { tier: latenessTier, autoAtIso } = computeLatenessTier({
    status: booking.status,
    startTimeUtc: booking.start_time_utc,
    nowIso,
    autoNoShowMinutes,
  });
  const latenessLabel =
    latenessTier === "critical"
      ? language === "vi"
        ? "Rất trễ"
        : "Very late"
      : language === "vi"
        ? "Trễ"
        : "Late";

  return (
    <motion.div
      data-testid={`booking-block-${booking.id}`}
      data-booking-source={booking.source}
      className={cn(
        "w-full rounded-xl border bg-white/[0.05] p-3 text-left transition-colors active:bg-white/[0.09]",
        latenessTier === "critical"
          ? "border-nq-error/70 ring-2 ring-nq-error/35"
          : latenessTier === "late"
            ? "border-nq-warning/70 ring-2 ring-nq-warning/25"
            : latenessTier === "due"
              ? "border-nq-primary/55 ring-1 ring-nq-primary/25"
              : "border-white/[0.07]",
      )}
      whileTap={{ scale: 0.98 }}
      onClick={onPress}
    >
      <button
        type="button"
        className="flex min-h-11 w-full items-start gap-2.5 text-left"
        onClick={(event) => {
          event.stopPropagation();
          onPress();
        }}
      >
        {/* Staff colour bar */}
        <div
          className="flex-shrink-0 self-stretch rounded-full"
          style={{ width: 3, backgroundColor: color, minHeight: "2.25rem" }}
        />

        <div className="min-w-0 flex-1">
          {/* Client name + VIP star */}
          <div className="mb-[2px] flex items-center gap-1.5">
            <div
              className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
              style={{ backgroundColor: dotColor }}
            />
            <span
              data-testid={`booking-block-client-${booking.id}`}
              className="truncate text-base font-semibold leading-tight text-white/90"
            >
              {booking.client_name}
            </span>
            {booking.is_vip && (
              <span className="leading-none text-nq-primary text-xs">★</span>
            )}
              {booking.seat_together ? (
              <span
                data-testid={`booking-block-icon-seat-together-${booking.id}`}
                role="img"
                aria-label={
                  language === "vi" ? "Yêu cầu ngồi cùng nhau" : "Seat together"
                }
                className="leading-none text-xs"
              >
                💕
              </span>
            ) : null}
          </div>

          {/* Service name */}
          <div
            data-testid={`booking-block-service-${booking.id}`}
            className="mb-1.5 truncate text-base text-white/60"
          >
            {booking.service_name}
          </div>

          {latenessTier && latenessTier !== "due" ? (
            <div
              data-testid={`booking-block-lateness-${booking.id}`}
              className="mb-2 flex flex-wrap items-center gap-1.5"
            >
              <span
                data-testid={`booking-block-icon-late-${booking.id}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                  latenessTier === "critical"
                    ? "bg-nq-error/25 text-red-200"
                    : "bg-nq-warning/20 text-amber-100",
                )}
              >
                <Clock size={11} aria-hidden />
                {latenessLabel}
              </span>
              {autoAtIso ? (
                <span className="text-xs text-white/60">
                  {language === "vi" ? "Xem xét vắng lúc" : "Review due at"}{" "}
                  {formatInSalonTz(autoAtIso, timezone, "shortTime")}
                </span>
              ) : null}
              {booking.no_show_candidate_at ? (
                <span
                  data-testid={`booking-block-no-show-candidate-${booking.id}`}
                  className="inline-flex items-center gap-1 rounded-full bg-nq-error/25 px-2 py-0.5 text-[10px] font-semibold text-red-200"
                >
                  <AlertTriangle size={11} aria-hidden />
                  {language === "vi"
                    ? "Cần quyết định vắng"
                    : "No-show decision needed"}
                </span>
              ) : null}
              {booking.after_hours_minutes ? (
                <span
                  data-testid={`booking-block-icon-after-hours-${booking.id}`}
                  className="rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                >
                  🌙 {booking.after_hours_minutes}m{" "}
                  {language === "vi" ? "ngoài giờ" : "after close"}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Time range + staff chip */}
          <div className="flex items-center justify-between gap-2">
            <span
              data-testid={`booking-block-time-${booking.id}`}
              className="text-base text-white/60"
            >
              {startStr}–{endStr}
            </span>
            <span
              data-testid={`booking-block-staff-${booking.id}`}
              className="flex-shrink-0 rounded-md border px-2 py-1 text-base font-medium text-white/90"
              style={{
                backgroundColor: color + "28",
                borderColor: color + "80",
              }}
            >
              {staffName}
            </span>
          </div>
        </div>
      </button>
      {latenessTier ? (
        <div
          data-testid={
            latenessTier === "due"
              ? `booking-block-lateness-${booking.id}`
              : undefined
          }
          className="mt-2 flex justify-end"
        >
          {onStart ? (
            <button
              type="button"
              data-testid={`booking-block-start-${booking.id}`}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-nq-success/20 px-3 text-base font-semibold text-nq-success"
              onClick={(event) => {
                event.stopPropagation();
                onStart();
              }}
            >
              <Play size={11} fill="currentColor" aria-hidden />
              {language === "vi" ? "Bắt đầu" : "Start"}
            </button>
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
}

function MobileNoShowTombstone({
  id,
  clientName,
  feeCents,
  chargeStatus,
  hasCard,
  language,
  currencyCode,
  onUndo,
  onCharge,
  onWaive,
}: {
  id: string;
  clientName: string;
  feeCents: number | null;
  chargeStatus: string | null;
  hasCard: boolean;
  language: "en" | "vi";
  currencyCode?: import("@/shared/lib/currencyFormat").Currency;
  onUndo?: () => void;
  onCharge?: () => void;
  onWaive?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const vi = language === "vi";
  const amount = feeCents
    ? (formatCurrency(feeCents, currencyCode) ?? "")
    : "";
  const canResolveFee =
    hasCard &&
    feeCents !== null &&
    feeCents > 0 &&
    chargeStatus !== "charged" &&
    chargeStatus !== "waived";
  const status =
    chargeStatus === "charged"
      ? vi
        ? `Đã thu ${amount}`
        : `Charged ${amount}`
      : chargeStatus === "waived"
        ? vi
          ? "Đã bỏ qua phí"
          : "Fee waived"
        : vi
          ? "Vắng mặt"
          : "No-show";

  return (
    <div
      data-testid={`noshow-tombstone-${id}`}
      className="w-full rounded-xl border border-dashed border-nq-error/50 bg-nq-error/10 p-3 text-left"
      onClick={() => setOpen((value) => !value)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={vi ? `Khách vắng: ${clientName}` : `No-show: ${clientName}`}
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span className="truncate text-sm font-semibold text-white/75 line-through decoration-nq-error/70">
          {clientName}
        </span>
        <span className="shrink-0 text-[11px] font-medium text-nq-error">
          {status}
        </span>
      </button>

      {open ? (
        <div
          className="mt-2 grid gap-1 border-t border-nq-error/20 pt-2"
          onClick={(event) => event.stopPropagation()}
        >
          {onUndo ? (
            <button
              type="button"
              className="min-h-10 rounded-lg px-2 text-left text-sm text-nq-success"
              onClick={() => {
                setOpen(false);
                onUndo();
              }}
            >
              {vi ? "Bỏ vắng (đã đến)" : "Undo no-show"}
            </button>
          ) : null}
          {canResolveFee && onCharge ? (
            <button
              type="button"
              className="min-h-10 rounded-lg px-2 text-left text-sm text-nq-warning"
              onClick={() => {
                setOpen(false);
                onCharge();
              }}
            >
              {vi ? `Thu phí ${amount}` : `Charge ${amount}`}
            </button>
          ) : null}
          {canResolveFee && onWaive ? (
            <button
              type="button"
              className="min-h-10 rounded-lg px-2 text-left text-sm text-white/60"
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
