import { checkBookingWithinOpeningHours } from "@/shared/booking/bookingWithinOpeningHours";
import {
  salonYmdOfUtc,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";

export type WalkinOpeningHoursCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "closed_day" | "invalid_hours" | "outside_hours";
    };

/**
 * Apply the same salon-local opening-hours contract used by desk bookings to
 * a walk-in's actual arrival time. A walk-in may be entered up to 30 minutes
 * late, so the selected arrival instant — not the form submission time — is
 * authoritative.
 */
export function checkWalkinWithinOpeningHours(args: {
  openingHoursRaw: unknown;
  bookingClosedDatesRaw?: unknown;
  timezone: string;
  actualArrivalAtIso: string;
  serviceDurationMinutes: number;
}): WalkinOpeningHoursCheck {
  const serviceDurationMinutes = Math.round(
    Number(args.serviceDurationMinutes),
  );
  if (!Number.isFinite(serviceDurationMinutes) || serviceDurationMinutes < 1) {
    return { ok: false, reason: "invalid_hours" };
  }

  try {
    const dateYmd = salonYmdOfUtc(args.actualArrivalAtIso, args.timezone);
    const startMinutes = utcIsoToSalonMinutesFromMidnight(
      args.actualArrivalAtIso,
      args.timezone,
    );
    return checkBookingWithinOpeningHours({
      openingHoursRaw: args.openingHoursRaw,
      bookingClosedDatesRaw: args.bookingClosedDatesRaw,
      dateYmd,
      startMinutes,
      serviceCompletionMinutes: serviceDurationMinutes,
    });
  } catch {
    // Invalid timezone/instant/config must fail closed. It is never safe to
    // reinterpret an unverifiable schedule as open capacity.
    return { ok: false, reason: "invalid_hours" };
  }
}
