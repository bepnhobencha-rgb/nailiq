import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { createClient } from "@/shared/lib/supabase/client";
import type { BookingStaffItem } from "@/shared/booking/loadBookingServices";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import { bookingDateYmdFromLocalDate } from "@/shared/booking/bookingConfirmLabels";

const SLOT_STEP_MINUTES = 30;
const BOOKING_BUFFER_MS = 15 * 60 * 1000;

/**
 * One slot in the booking-time grid. `available: false` means the slot is in
 * opening-hours range but already booked across all selectable staff, so the
 * UI renders it as disabled (visible but un-clickable). Past-time slots are
 * still hidden — they're noise rather than information.
 */
export type TimeSlot = {
  label: string;
  available: boolean;
};

function localDayBounds(d: Date): { start: Date; end: Date } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function formatSlotLabel(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

type OccupancyRow = {
  staff_id: string;
  start_time_utc: string;
  end_time_utc: string;
};

export type GetAvailableTimeSlotsParams = {
  salonId: string;
  openingHoursRaw: unknown;
  selectedDate: Date;
  staffId: string;
  staffList: readonly BookingStaffItem[];
  serviceDurationMinutes: number;
  /** Salon-specific YYYY-MM-DD closures (holidays). */
  closedDateYmdSet?: ReadonlySet<string>;
};

/**
 * Pure slot computation — no Supabase, no `Date.now()`. Tests target this
 * directly; the exported `getAvailableTimeSlots` is a thin RPC wrapper.
 *
 * Returns slots that fit inside the day's opening hours, with `available`
 * reflecting per-staff occupancy. Past-time slots are omitted entirely
 * (matches prior UX — past-time clutter outweighs information value).
 */
export function computeTimeSlots(args: {
  openingHoursRaw: unknown;
  selectedDate: Date;
  staffId: string;
  staffList: readonly BookingStaffItem[];
  serviceDurationMinutes: number;
  occupancy: readonly OccupancyRow[];
  /** Substitute for `Date.now()` so tests are deterministic. */
  nowMs: number;
  /** Salon-specific YYYY-MM-DD closures (holidays). */
  closedDateYmdSet?: ReadonlySet<string>;
}): TimeSlot[] {
  const {
    openingHoursRaw,
    selectedDate,
    staffId,
    staffList,
    serviceDurationMinutes,
    occupancy,
    nowMs,
    closedDateYmdSet,
  } = args;

  const durationMin = Math.max(1, Math.round(Number(serviceDurationMinutes) || 1));
  const durationMs = durationMin * 60_000;

  const week = parseOpeningHours(openingHoursRaw);
  if (!week) return [];

  const ymd = bookingDateYmdFromLocalDate(selectedDate);
  if (closedDateYmdSet?.has(ymd)) return [];

  const dayKey = dayKeyFromLocalDate(selectedDate);
  const dayCfg = week[dayKey];
  if (!dayCfg || dayCfg.closed) return [];

  const openMin = hmToMinutes(dayCfg.open);
  const closeMin = hmToMinutes(dayCfg.close);
  if (closeMin <= openMin) return [];

  const occIntervals = occupancy.map((row) => ({
    staffId: String(row.staff_id),
    startMs: new Date(row.start_time_utc).getTime(),
    endMs: new Date(row.end_time_utc).getTime(),
  }));

  function isStaffFree(
    staffUuid: string,
    slotStartMs: number,
    slotEndMs: number,
  ): boolean {
    for (const o of occIntervals) {
      if (o.staffId !== staffUuid) continue;
      if (intervalsOverlapMs(slotStartMs, slotEndMs, o.startMs, o.endMs)) {
        return false;
      }
    }
    return true;
  }

  function slotAvailableForSelection(
    slotStartMs: number,
    slotEndMs: number,
  ): boolean {
    if (staffId !== BOOKING_ANY_STAFF_ID) {
      return isStaffFree(staffId, slotStartMs, slotEndMs);
    }
    if (staffList.length === 0) return false;
    return staffList.some((s) => isStaffFree(s.id, slotStartMs, slotEndMs));
  }

  const slots: TimeSlot[] = [];
  const base = new Date(selectedDate);
  base.setHours(0, 0, 0, 0);

  const sameCalendarDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const now = new Date(nowMs);
  const isToday = sameCalendarDay(selectedDate, now);

  for (
    let mins = openMin;
    mins + durationMin <= closeMin;
    mins += SLOT_STEP_MINUTES
  ) {
    const slotStart = new Date(base);
    slotStart.setHours(0, mins, 0, 0);
    const slotEnd = new Date(slotStart.getTime() + durationMs);

    const closeBoundary = new Date(base);
    closeBoundary.setHours(0, closeMin, 0, 0);
    if (slotEnd.getTime() > closeBoundary.getTime()) continue;

    if (isToday && slotStart.getTime() < nowMs + BOOKING_BUFFER_MS) {
      continue;
    }

    const available = slotAvailableForSelection(
      slotStart.getTime(),
      slotEnd.getTime(),
    );
    slots.push({ label: formatSlotLabel(slotStart), available });
  }

  return slots;
}

export async function getAvailableTimeSlots(
  params: GetAvailableTimeSlotsParams,
): Promise<TimeSlot[]> {
  const {
    salonId,
    openingHoursRaw,
    selectedDate,
    staffId,
    staffList,
    serviceDurationMinutes,
    closedDateYmdSet,
  } = params;

  const week = parseOpeningHours(openingHoursRaw);
  if (!week) return [];
  const dayCfg = week[dayKeyFromLocalDate(selectedDate)];
  if (!dayCfg || dayCfg.closed) return [];

  const ymd = bookingDateYmdFromLocalDate(selectedDate);
  if (closedDateYmdSet?.has(ymd)) return [];

  const { start: dayStart, end: dayEnd } = localDayBounds(selectedDate);
  const supabase = createClient();
  let occupancy: OccupancyRow[] = [];

  const { data: occData, error: occErr } = await supabase.rpc(
    "public_booking_occupancy_for_range",
    {
      p_salon_id: salonId,
      p_start: dayStart.toISOString(),
      p_end: dayEnd.toISOString(),
    },
  );

  if (!occErr && Array.isArray(occData)) {
    occupancy = occData as OccupancyRow[];
  }

  return computeTimeSlots({
    openingHoursRaw,
    selectedDate,
    staffId,
    staffList,
    serviceDurationMinutes,
    occupancy,
    nowMs: Date.now(),
    closedDateYmdSet,
  });
}

/** Available-slot count for calendar hints (parallel-safe when called per date). */
export async function getAvailableTimeSlotsCount(
  params: GetAvailableTimeSlotsParams,
): Promise<number> {
  const slots = await getAvailableTimeSlots(params);
  return slots.filter((s) => s.available).length;
}
