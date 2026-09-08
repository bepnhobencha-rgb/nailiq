import type { TimeSlot } from "@/shared/booking/getAvailableTimeSlots";

function slotMinutes(label: string): number {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label.trim());
  if (!match) return Number.MAX_SAFE_INTEGER;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return hour * 60 + Number(match[2]);
}

/**
 * The booking being edited is allowed to keep its own current slot. Public
 * availability includes that row as occupancy, so the edit UI restores this
 * one known-safe choice while the mutation still revalidates conflicts and
 * excludes only the same booking ID on the server.
 */
export function restoreOriginalBookingSlot(
  slots: readonly TimeSlot[],
  args: { sameSalonDay: boolean; originalSlotLabel: string },
): TimeSlot[] {
  if (!args.sameSalonDay) return [...slots];
  let found = false;
  const restored = slots.map((slot) => {
    if (slot.label !== args.originalSlotLabel) return slot;
    found = true;
    return { ...slot, available: true };
  });
  if (!found) {
    restored.push({ label: args.originalSlotLabel, available: true });
  }
  return restored.sort((a, b) => {
    const availabilityOrder = Number(b.available) - Number(a.available);
    return availabilityOrder || slotMinutes(a.label) - slotMinutes(b.label);
  });
}
