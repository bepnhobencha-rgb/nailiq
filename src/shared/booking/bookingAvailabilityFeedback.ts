import type { BookingMessages } from "@/shared/i18n/booking/en";
import type { TimeSlot } from "@/shared/booking/getAvailableTimeSlots";

/** Local UI state only. Never use these presentation codes as RPC outcomes. */
export const BOOKING_AVAILABILITY_ERROR = {
  slotJustTaken: "booking_ui_slot_just_taken",
  waitlistUnverified: "booking_ui_waitlist_unverified",
  gridUnverified: "booking_ui_grid_unverified",
} as const;

/** Resolve at render time so changing language preserves the error's meaning. */
export function resolveBookingAvailabilityError(
  error: string | null,
  t: Pick<BookingMessages, "bookingErrors" | "waitlistAvailabilityUnverified" | "availabilityGridUnverified">,
): string | null {
  if (error === BOOKING_AVAILABILITY_ERROR.slotJustTaken) {
    return t.bookingErrors.slotJustTaken;
  }
  if (error === BOOKING_AVAILABILITY_ERROR.waitlistUnverified) {
    return t.waitlistAvailabilityUnverified;
  }
  if (error === BOOKING_AVAILABILITY_ERROR.gridUnverified) {
    return t.availabilityGridUnverified;
  }
  // Other errors and sentinel values (e.g. pricing_changed) keep their contract.
  return error;
}

export function bookingTimeSlotAriaLabel(
  slot: TimeSlot,
  t: Pick<BookingMessages, "slotUnavailable" | "slotBestFit" | "slotRecommended" | "popularBadge">,
  popular: boolean,
): string {
  const description = !slot.available
    ? t.slotUnavailable
    : slot.scoringLabel === "best_fit"
      ? t.slotBestFit
      : slot.scoringLabel === "recommended"
        ? t.slotRecommended
        : popular ? t.popularBadge : null;
  return description ? `${slot.label} (${description})` : slot.label;
}
