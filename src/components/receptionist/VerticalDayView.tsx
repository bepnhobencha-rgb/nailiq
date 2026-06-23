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

import { useCallback, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { formatInSalonTz } from "@/shared/lib/salonTime";
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

/** Add/subtract N calendar days from a YYYY-MM-DD string (UTC arithmetic). */
function addDaysToYmd(ymd: string, delta: number): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d + delta));
  return date.toISOString().slice(0, 10);
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
  onAddBooking: () => void;
  language?: "en" | "vi";
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
  language = "en",
}: VerticalDayViewProps) {
  const open = openMinutes ?? DEFAULT_OPEN;
  const close = closeMinutes ?? DEFAULT_CLOSE;

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

  // Current-time position for the "now" red line
  const nowMins = useMemo(
    () =>
      isViewingToday && nowIso ? utcToSalonMinutes(nowIso, timezone) : null,
    [isViewingToday, nowIso, timezone],
  );

  // Generate 30-min time slots
  const slots = useMemo(() => {
    const arr: number[] = [];
    for (let m = open; m < close; m += SLOT_MIN) arr.push(m);
    return arr;
  }, [open, close]);

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

  const addLabel = language === "vi" ? "Thêm hẹn" : "New appt";

  return (
    <div
      className="relative select-none pb-28"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {slots.map((slot) => {
        const slotBookings = bookingsBySlot.get(slot) ?? [];
        const isHour = slot % 60 === 0;
        const hasBookings = slotBookings.length > 0;

        // Show the "now" red line inside the slot where the current time falls
        const nowLineHere =
          nowMins !== null && nowMins >= slot && nowMins < slot + SLOT_MIN;
        const nowLinePct =
          nowLineHere && nowMins !== null
            ? ((nowMins - slot) / SLOT_MIN) * 100
            : null;

        // Skip empty :30 slots to keep the list tight (only :00 get empty rows)
        if (!hasBookings && !isHour && !nowLineHere) return null;

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
                  <span className="text-[11px] font-semibold tracking-wide text-white/50">
                    {minsToLabel(slot)}
                  </span>
                ) : (
                  <span className="text-[10px] text-white/20">
                    {minsToLabel(slot)}
                  </span>
                )}
              </div>

              {/* Bookings or empty-slot tap area */}
              <div className="min-w-0 flex-1 space-y-1.5">
                {hasBookings ? (
                  slotBookings.map((booking) => (
                    <BookingCard
                      key={booking.id}
                      booking={booking}
                      color={staffColorMap[booking.staff_id] ?? "#888"}
                      staffName={staffNameMap[booking.staff_id] ?? ""}
                      timezone={timezone}
                      onPress={() => onBookingClick(booking.id)}
                    />
                  ))
                ) : isHour ? (
                  <button
                    className="flex h-9 w-full items-center gap-1.5 rounded-lg border border-dashed border-white/[0.08] px-3 text-[11px] text-white/20 transition-colors active:border-white/25 active:text-white/40"
                    onClick={() => {
                      if (onEmptySlotClick && staff.length > 0) {
                        onEmptySlotClick(
                          staff[0].id,
                          selectedDate,
                          minsToLabel(slot),
                        );
                      } else {
                        onAddBooking();
                      }
                    }}
                  >
                    <Plus size={11} className="opacity-60" />
                    {minsToLabel(slot)}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}

      {/* Floating action button — "+ New appt" (left side avoids Ask Coco on right) */}
      <div className="fixed bottom-20 left-4 z-30">
        <button
          onClick={onAddBooking}
          className="flex items-center gap-2 rounded-full bg-nq-primary px-4 py-3 text-sm font-semibold text-black shadow-lg transition-transform active:scale-95"
        >
          <Plus size={16} strokeWidth={2.5} />
          {addLabel}
        </button>
      </div>
    </div>
  );
}

// ──────────────────────────────── booking card ─────────────────────────────────

function BookingCard({
  booking,
  color,
  staffName,
  timezone,
  onPress,
}: {
  booking: GridBooking;
  color: string;
  staffName: string;
  timezone: string;
  onPress: () => void;
}) {
  const startStr = formatInSalonTz(booking.start_time_utc, timezone, "shortTime");
  const endStr = formatInSalonTz(booking.end_time_utc, timezone, "shortTime");
  const dotColor = STATUS_DOT[booking.status] ?? STATUS_DOT.pending;

  return (
    <motion.button
      className="w-full rounded-xl border border-white/[0.07] bg-white/[0.05] p-3 text-left transition-colors active:bg-white/[0.09]"
      whileTap={{ scale: 0.98 }}
      onClick={onPress}
    >
      <div className="flex items-start gap-2.5">
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
            <span className="truncate text-sm font-semibold leading-tight text-white/90">
              {booking.client_name}
            </span>
            {booking.is_vip && (
              <span className="leading-none text-nq-primary text-xs">★</span>
            )}
          </div>

          {/* Service name */}
          <div className="mb-1.5 truncate text-xs text-white/50">
            {booking.service_name}
          </div>

          {/* Time range + staff chip */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-white/35">
              {startStr}–{endStr}
            </span>
            <span
              className="flex-shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
              style={{ backgroundColor: color + "28", color }}
            >
              {staffName}
            </span>
          </div>
        </div>
      </div>
    </motion.button>
  );
}
