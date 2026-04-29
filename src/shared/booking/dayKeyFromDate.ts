import type { DayKey } from "@/shared/dashboard/openingHoursDefaults";

/** Maps JS weekday (`Date#getDay`, Sun=0 … Sat=6) to opening_hours keys. */
export function dayKeyFromLocalDate(d: Date): DayKey {
  const keys: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return keys[d.getDay()]!;
}
