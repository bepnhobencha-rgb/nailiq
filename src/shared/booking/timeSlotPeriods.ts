import type { TimeSlot } from "@/shared/booking/getAvailableTimeSlots";

export type TimeSlotPeriod = "morning" | "midday" | "afternoon" | "evening";

export const TIME_SLOT_PERIODS: readonly TimeSlotPeriod[] = [
  "morning",
  "midday",
  "afternoon",
  "evening",
];

/** Parse the canonical public-booking label (`h:mm AM/PM`) without relying on
 * the customer's locale or timezone. Invalid labels are left ungrouped. */
export function timeSlotLabelToMinutes(label: string): number | null {
  const match = /^(\d{1,2}):(\d{2})\s+(AM|PM)$/i.exec(label.trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;

  const normalizedHour = hour % 12 + (match[3]?.toUpperCase() === "PM" ? 12 : 0);
  return normalizedHour * 60 + minute;
}

export function timeSlotPeriodForLabel(label: string): TimeSlotPeriod | null {
  const minutes = timeSlotLabelToMinutes(label);
  if (minutes === null) return null;
  if (minutes < 12 * 60) return "morning";
  if (minutes < 14 * 60) return "midday";
  if (minutes < 17 * 60) return "afternoon";
  return "evening";
}

export function groupTimeSlotsByPeriod(
  slots: readonly TimeSlot[],
): Record<TimeSlotPeriod, TimeSlot[]> {
  const groups: Record<TimeSlotPeriod, TimeSlot[]> = {
    morning: [],
    midday: [],
    afternoon: [],
    evening: [],
  };

  for (const slot of slots) {
    const period = timeSlotPeriodForLabel(slot.label);
    if (period) groups[period].push(slot);
  }

  return groups;
}

/** Existing smart scheduling scores remain authoritative. When scores tie (or
 * are absent), preserve the server's chronological order. */
export function bestAvailableTimeSlots(
  slots: readonly TimeSlot[],
  limit = 3,
): TimeSlot[] {
  return slots
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => slot.available)
    .sort((a, b) => (b.slot.score ?? 0) - (a.slot.score ?? 0) || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ slot }) => slot);
}
