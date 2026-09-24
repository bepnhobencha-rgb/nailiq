import { salonDateOffset } from "@/shared/lib/salonTime";

/** Use the same server clock for SSR and hydration, never the viewer's day. */
export function receptionistDateOffset(
  selectedDate: string,
  timezone: string,
  observedAtIso: string,
): -1 | 0 | 1 | null {
  return ([-1, 0, 1] as const).find(
    (offset) => salonDateOffset(timezone, offset, observedAtIso) === selectedDate,
  ) ?? null;
}

/** A background reload may finish after the operator has changed days. Apply
 * it against current React state, not the date captured before awaiting I/O. */
export function applyReceptionistDaySnapshot<T extends { selectedDate: string }>(
  current: T,
  response: T,
  requestedDate: string,
): T {
  return current.selectedDate === requestedDate && response.selectedDate === requestedDate
    ? response
    : current;
}
