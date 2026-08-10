import {
  checkBookingWithinOpeningHours,
  type BookingHoursCheck,
} from "@/shared/booking/bookingWithinOpeningHours";

export type GroupHoursMember = {
  dateYmd: string;
  startMinutes: number;
  serviceCompletionMinutes: number;
};

export type GroupBookingHoursCheck =
  | { ok: true }
  | {
      ok: false;
      memberIndex: number;
      reason: Exclude<BookingHoursCheck, { ok: true }>["reason"];
    };

/**
 * Shared group-booking policy boundary used by public web, desk and Voice/SMS.
 *
 * Command handlers remain separate because they have different identity and
 * side-effect rules. They all feed their authoritative member timing into this
 * small policy helper so one late member cannot slip past closing time.
 */
export function checkGroupWithinOpeningHours(args: {
  openingHoursRaw: unknown;
  bookingClosedDatesRaw?: unknown;
  members: readonly GroupHoursMember[];
}): GroupBookingHoursCheck {
  for (let memberIndex = 0; memberIndex < args.members.length; memberIndex++) {
    const member = args.members[memberIndex]!;
    const check = checkBookingWithinOpeningHours({
      openingHoursRaw: args.openingHoursRaw,
      bookingClosedDatesRaw: args.bookingClosedDatesRaw,
      dateYmd: member.dateYmd,
      startMinutes: member.startMinutes,
      serviceCompletionMinutes: member.serviceCompletionMinutes,
    });
    if (!check.ok) {
      return { ok: false, memberIndex, reason: check.reason };
    }
  }

  return { ok: true };
}
