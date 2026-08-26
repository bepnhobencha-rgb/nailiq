import type { OccupancyInterval } from "@/shared/booking/fetchBookingOccupancy";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import type { OpeningHoursWeek } from "@/shared/dashboard/openingHoursDefaults";
import { salonWallTimeToUtcIso } from "@/shared/lib/salonTime";

/**
 * Minutes between end of the guest block and the next booking start for this staff,
 * or until salon close if nothing follows. Used for pre-confirm upsell (real float only).
 */
export function computeStaffFloatGapMinutes(args: {
  occIntervals: readonly OccupancyInterval[];
  staffId: string;
  slotEndMs: number;
  dateYmd: string;
  timezone: string;
  week: OpeningHoursWeek;
}): number {
  const { occIntervals, staffId, slotEndMs, dateYmd, timezone, week } = args;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  if (!match) return 0;
  const dayIndex = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  )).getUTCDay();
  const dayKey = (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const)[dayIndex];
  const cfg = week[dayKey];
  if (!cfg || cfg.closed) return 0;
  const closeMin = hmToMinutes(cfg.close);
  let closeMs: number;
  try {
    closeMs = Date.parse(salonWallTimeToUtcIso(dateYmd, closeMin, timezone));
  } catch {
    return 0;
  }

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
