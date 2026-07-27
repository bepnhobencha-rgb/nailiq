import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import {
  parseOpeningHours,
  type DayKey,
} from "@/shared/dashboard/openingHoursDefaults";

export const MAX_AFTER_HOURS_EXTENSION_MINUTES = 120;

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
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return Number.isNaN(date.getTime()) ? null : (DAY_KEYS[date.getUTCDay()] ?? null);
}

export type ControlledAfterHoursResult =
  | {
      ok: true;
      closeMinutes: number;
      afterHoursMinutes: number;
    }
  | {
      ok: false;
      reason:
        | "closed_day"
        | "invalid_hours"
        | "inside_hours"
        | "before_open"
        | "extension_too_long";
    };

/**
 * Pure business rule for a controlled, staff-approved desk exception.
 *
 * It never changes public availability. The selected day must be a normal open
 * day, the appointment cannot begin before opening, and the customer-facing
 * service (excluding only the final cleanup buffer) may finish at most two
 * hours after close.
 */
export function evaluateControlledAfterHours(args: {
  openingHoursRaw: unknown;
  bookingClosedDatesRaw?: unknown;
  dateYmd: string;
  startMinutes: number;
  serviceCompletionMinutes: number;
}): ControlledAfterHoursResult {
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
  const start = Math.round(Number(startMinutes));
  const completion = Math.round(Number(serviceCompletionMinutes));
  if (
    closeMinutes <= openMinutes ||
    !Number.isFinite(start) ||
    !Number.isFinite(completion) ||
    completion < 1
  ) {
    return { ok: false, reason: "invalid_hours" };
  }
  if (start < openMinutes) return { ok: false, reason: "before_open" };

  const afterHoursMinutes = start + completion - closeMinutes;
  if (afterHoursMinutes <= 0) return { ok: false, reason: "inside_hours" };
  if (
    afterHoursMinutes > MAX_AFTER_HOURS_EXTENSION_MINUTES ||
    start + completion > 24 * 60
  ) {
    return { ok: false, reason: "extension_too_long" };
  }
  return { ok: true, closeMinutes, afterHoursMinutes };
}
