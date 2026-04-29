import type { OccupancyInterval } from "@/shared/booking/fetchBookingOccupancy";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import type { OpeningHoursWeek } from "@/shared/dashboard/openingHoursDefaults";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";

/**
 * Minutes between end of the guest block and the next booking start for this staff,
 * or until salon close if nothing follows. Used for pre-confirm upsell (real float only).
 */
export function computeStaffFloatGapMinutes(args: {
  occIntervals: readonly OccupancyInterval[];
  staffId: string;
  slotEndMs: number;
  selectedDate: Date;
  week: OpeningHoursWeek;
}): number {
  const { occIntervals, staffId, slotEndMs, selectedDate, week } = args;
  const dayKey = dayKeyFromLocalDate(selectedDate);
  const cfg = week[dayKey];
  if (!cfg || cfg.closed) return 0;
  const closeMin = hmToMinutes(cfg.close);
  const base = new Date(selectedDate);
  base.setHours(0, 0, 0, 0);
  const closeBoundary = new Date(base);
  closeBoundary.setHours(0, closeMin, 0, 0);
  const closeMs = closeBoundary.getTime();

  let nextStart: number | null = null;
  for (const o of occIntervals) {
    if (o.staffId !== staffId) continue;
    if (o.startMs >= slotEndMs - 1) {
      if (nextStart === null || o.startMs < nextStart) {
        nextStart = o.startMs;
      }
    }
  }

  const boundary = nextStart ?? closeMs;
  return Math.max(0, Math.floor((boundary - slotEndMs) / 60_000));
}
