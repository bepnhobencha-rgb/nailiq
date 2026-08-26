/**
 * Sort the front-desk queue by operational risk/readiness and FIFO age.
 * VIP is intentionally absent from the decision inputs: recognition cannot
 * displace an older or operationally urgent customer.
 */
const QUEUE_LONG_WAIT_DANGER_MS = 20 * 60 * 1000;

export function sortQueueByPriority<
  T extends {
    joined_queue_at: string;
    requested_staff_name: string | null;
    requested_staff_ready_at_iso: string | null;
  },
>(queue: T[], nowMs: number): T[] {
  function band(item: T): number {
    const joinedMs = Date.parse(item.joined_queue_at);
    if (
      Number.isFinite(joinedMs) &&
      nowMs - joinedMs >= QUEUE_LONG_WAIT_DANGER_MS
    ) {
      return 0;
    }
    if (item.requested_staff_name) {
      const readyMs = item.requested_staff_ready_at_iso
        ? Date.parse(item.requested_staff_ready_at_iso)
        : NaN;
      if (Number.isFinite(readyMs) && readyMs <= nowMs) return 1;
    }
    return 2;
  }

  queue.sort((a, b) => {
    const bandDelta = band(a) - band(b);
    if (bandDelta !== 0) return bandDelta;
    const aMs = Date.parse(a.joined_queue_at);
    const bMs = Date.parse(b.joined_queue_at);
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) return aMs - bMs;
    return 0;
  });
  return queue;
}
