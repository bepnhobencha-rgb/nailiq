import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { createClient } from "@/shared/lib/supabase/client";
import type { BookingStaffItem } from "@/shared/booking/loadBookingServices";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import { bookingDateYmdFromLocalDate } from "@/shared/booking/bookingConfirmLabels";

/**
 * Slot grid resolution in minutes.
 *
 * 15 min covers all common nail-service durations (30 / 45 / 60 / 90) without
 * leaving dead-time gaps between back-to-back appointments. Industry standard
 * for beauty scheduling (Fresha, Square Appointments, Vagaro all use 15 min).
 *
 * Previously 30 min — changed to 15 to eliminate "wasted" gaps, e.g.
 * a 45-min service ending at 12:45 no longer leaves a 15-min hole before
 * the 13:00 grid slot.
 */
const SLOT_STEP_MINUTES = 15;
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
 * Slot generation uses a TWO-PHASE approach (Fresha / Square Appointments
 * pattern) to eliminate dead-time gaps between back-to-back appointments:
 *
 * Phase 1 — Regular 15-min grid (SLOT_STEP_MINUTES)
 *   Generates slots at :00 / :15 / :30 / :45 within opening hours.
 *   All slots (including occupied ones) are returned so the UI can render
 *   blocked times as visibly disabled.
 *
 * Phase 2 — Exact booking end-time anchors
 *   After Phase 1, scans occupancy for booking end-times that do NOT fall
 *   on a 15-min boundary (e.g. a 50-min service ending at 10:50). Each such
 *   time is injected as an AVAILABLE-ONLY slot so the very next customer
 *   can start immediately without a gap. Uses timezone-safe ms arithmetic
 *   (endMs − baseMidnightMs) to avoid `getHours()`/local-tz pitfalls.
 *
 * Result: sorted by time, deduplicated by start-ms.
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

  // `base` = local midnight of the selected day (timezone-aware anchor).
  // All minute offsets (openMin, closeMin, SLOT_STEP_MINUTES) are relative
  // to this anchor. Anchor-slot extraction also uses base.getTime() for
  // timezone-safe ms arithmetic — see Phase 2 below.
  const base = new Date(selectedDate);
  base.setHours(0, 0, 0, 0);
  const baseMidnightMs = base.getTime();

  const sameCalendarDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const now = new Date(nowMs);
  const isToday = sameCalendarDay(selectedDate, now);

  // Closing boundary in ms — used to guard against slots that run past close.
  const closeBoundaryMs = baseMidnightMs + closeMin * 60_000;

  // ── Phase 1: regular 15-min grid ─────────────────────────────────────────
  // Map<startMs, TimeSlot> — keyed by ms for O(1) dedup in Phase 2.
  // ALL grid slots (occupied or free) are included so the UI can render
  // disabled times as visual feedback.
  const slotMap = new Map<number, TimeSlot>();

  for (
    let mins = openMin;
    mins + durationMin <= closeMin;
    mins += SLOT_STEP_MINUTES
  ) {
    const slotStart = new Date(base);
    slotStart.setHours(0, mins, 0, 0);
    const slotStartMs = slotStart.getTime();
    const slotEndMs = slotStartMs + durationMs;

    // Guard: service must not run past closing time.
    if (slotEndMs > closeBoundaryMs) continue;

    // Guard: past + buffer (today only).
    if (isToday && slotStartMs < nowMs + BOOKING_BUFFER_MS) continue;

    const available = slotAvailableForSelection(slotStartMs, slotEndMs);
    slotMap.set(slotStartMs, { label: formatSlotLabel(slotStart), available });
  }

  // ── Phase 2: exact booking end-time anchors ───────────────────────────────
  // For each occupancy interval whose end-time does NOT land on a SLOT_STEP
  // boundary, inject an available-only slot at that exact minute.
  //
  // Example: a 50-min service at 10:00 ends at 10:50. With a 15-min grid,
  // the next grid slot is 11:00, leaving a 10-minute gap. By injecting 10:50,
  // the next customer can start immediately with zero dead time.
  //
  // TIMEZONE-SAFE arithmetic: we compute minutes-from-local-midnight as
  //   (endMs − baseMidnightMs) / 60_000
  // instead of calling getHours()/getMinutes() which are TZ-dependent on the
  // server (would give UTC hours, not salon-local hours).
  //
  // Only AVAILABLE anchors are injected — unavailable ones are confusing (the
  // nearest grid slot already conveys "this time is blocked").

  for (const o of occIntervals) {
    const minsFromMidnight = (o.endMs - baseMidnightMs) / 60_000;

    // Must be strictly on the selected calendar day (0 inclusive, 1440 exclusive).
    if (minsFromMidnight < 0 || minsFromMidnight >= 24 * 60) continue;

    const endMins = Math.round(minsFromMidnight);

    // Skip if already on the grid — Phase 1 already covers it.
    if (endMins % SLOT_STEP_MINUTES === 0) continue;

    // Must be within opening hours and leave room for the full service.
    if (endMins < openMin || endMins + durationMin > closeMin) continue;

    const slotStart = new Date(base);
    slotStart.setHours(0, endMins, 0, 0);
    const slotStartMs = slotStart.getTime();
    const slotEndMs = slotStartMs + durationMs;

    // Service must not run past closing time (double-check after setHours rounding).
    if (slotEndMs > closeBoundaryMs) continue;

    // Skip if already in the map (another occupancy row has the same end time).
    if (slotMap.has(slotStartMs)) continue;

    // Past + buffer guard (today only).
    if (isToday && slotStartMs < nowMs + BOOKING_BUFFER_MS) continue;

    // Only inject when the slot is genuinely free.
    const available = slotAvailableForSelection(slotStartMs, slotEndMs);
    if (!available) continue;

    slotMap.set(slotStartMs, { label: formatSlotLabel(slotStart), available: true });
  }

  // Sort by start time and return as an array.
  return [...slotMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, slot]) => slot);
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
