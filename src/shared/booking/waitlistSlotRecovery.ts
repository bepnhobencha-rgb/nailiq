import type { TimeSlot } from "@/shared/booking/getAvailableTimeSlots";

/** A server recovery hint is not a reservation or a replacement for the grid. */
export function recoverWaitlistSlotFromFreshGrid(
  slotLabel: string,
  freshSlots: readonly TimeSlot[],
): string | null {
  return freshSlots.some((slot) => slot.label === slotLabel && slot.available)
    ? slotLabel
    : null;
}
