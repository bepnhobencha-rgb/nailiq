import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import {
  parseOpeningHours,
  type DayKey,
} from "@/shared/dashboard/openingHoursDefaults";

export type BookingHoursCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "closed_day" | "invalid_hours" | "outside_hours";
    };

const DAY_KEYS: readonly DayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

function dayKeyFromYmd(dateYmd: string): DayKey | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return DAY_KEYS[date.getUTCDay()] ?? null;
}

/**
 * Validate the customer-facing service span against salon opening hours.
 *
 * `serviceCompletionMinutes` deliberately excludes only the final cleanup
 * buffer. The booking row still stores the full block, so overlap protection
 * remains conservative after closing time.
 */
export function checkBookingWithinOpeningHours(args: {
  openingHoursRaw: unknown;
  bookingClosedDatesRaw?: unknown;
  dateYmd: string;
  startMinutes: number;
  serviceCompletionMinutes: number;
}): BookingHoursCheck {
  const {
    openingHoursRaw,
    bookingClosedDatesRaw,
    dateYmd,
    startMinutes,
    serviceCompletionMinutes,
  } = args;

  const week = parseOpeningHours(openingHoursRaw);
  const dayKey = dayKeyFromYmd(dateYmd);
  if (!week || !dayKey) return { ok: false, reason: "invalid_hours" };

  if (
    Array.isArray(bookingClosedDatesRaw) &&
    bookingClosedDatesRaw.some((value) => String(value) === dateYmd)
  ) {
    return { ok: false, reason: "closed_day" };
  }

  const cfg = week[dayKey];
  if (!cfg || cfg.closed) return { ok: false, reason: "closed_day" };

  const openMinutes = hmToMinutes(cfg.open);
  const closeMinutes = hmToMinutes(cfg.close);
  if (closeMinutes <= openMinutes) {
    return { ok: false, reason: "invalid_hours" };
  }

  const start = Math.round(Number(startMinutes));
  const completion = Math.round(Number(serviceCompletionMinutes));
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(completion) ||
    completion < 1 ||
    start < openMinutes ||
    start >= closeMinutes ||
    start + completion > closeMinutes
  ) {
    return { ok: false, reason: "outside_hours" };
  }

  return { ok: true };
}
