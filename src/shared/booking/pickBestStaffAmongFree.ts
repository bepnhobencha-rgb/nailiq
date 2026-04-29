import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import type { OccupancyInterval } from "@/shared/booking/fetchBookingOccupancy";

/**
 * Flowchart SMART LOGIC: among staff free for this slot — fewest bookings that day,
 * then whoever finished their previous booking *closest* to this slot start (largest
 * `lastEndBeforeSlot` ≤ slot start) to pack small gaps, then name.
 */
export function pickBestStaffAmongFree(
  freeStaffIds: readonly string[],
  orderedStaff: readonly { id: string; name: string }[],
  occIntervals: readonly OccupancyInterval[],
  dayStartMs: number,
  dayEndMs: number,
  slotStartMs: number,
): string {
  const free = new Set(freeStaffIds.map(String));

  function countDayBookings(staffId: string): number {
    let n = 0;
    for (const o of occIntervals) {
      if (o.staffId !== staffId) continue;
      if (intervalsOverlapMs(o.startMs, o.endMs, dayStartMs, dayEndMs)) {
        n += 1;
      }
    }
    return n;
  }

  /** Latest end time of any booking that finishes at or before the new slot starts; dayStart if none. */
  function lastEndBeforeSlot(staffId: string): number {
    let maxEnd = 0;
    for (const o of occIntervals) {
      if (o.staffId !== staffId) continue;
      if (o.endMs <= slotStartMs) {
        maxEnd = Math.max(maxEnd, o.endMs);
      }
    }
    return maxEnd === 0 ? dayStartMs : maxEnd;
  }

  const candidates = orderedStaff.filter((r) => free.has(String(r.id)));
  if (candidates.length === 0) {
    throw new Error("no_free_staff");
  }

  const ranked = [...candidates].sort((a, b) => {
    const ca = countDayBookings(String(a.id));
    const cb = countDayBookings(String(b.id));
    if (ca !== cb) return ca - cb;

    const la = lastEndBeforeSlot(String(a.id));
    const lb = lastEndBeforeSlot(String(b.id));
    /** Prefer larger end time = tighter gap before this slot (fill dead time). */
    if (la !== lb) return lb - la;

    return String(a.name ?? "").localeCompare(String(b.name ?? ""), "en");
  });

  return String(ranked[0]!.id);
}
