import {
  resolveBookingDayWindow,
} from "@/shared/booking/bookingWithinOpeningHours";

export const MAX_AFTER_HOURS_EXTENSION_MINUTES = 120;

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
  const window = resolveBookingDayWindow({
    openingHoursRaw,
    bookingClosedDatesRaw,
    dateYmd,
  });
  if (!window.ok) return window;
  const { openMinutes, closeMinutes } = window;
  const start = Math.round(Number(startMinutes));
  const completion = Math.round(Number(serviceCompletionMinutes));
  if (
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
