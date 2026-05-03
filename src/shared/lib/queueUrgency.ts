const URGENCY_KW = /vội|urgent|gấp/i;

/**
 * Minutes waited since joined queue.
 */
export function minutesWaiting(joinedQueueAtIso: string, nowIso?: string): number {
  const start = Date.parse(joinedQueueAtIso);
  const now = nowIso !== undefined ? Date.parse(nowIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(now)) {
    return 0;
  }
  return Math.floor(Math.max(0, now - start) / 60_000);
}

/**
 * Returns true if walk-in queue item should show urgent badge.
 * Logic: waited >= 20 min OR note contains vi/en urgency words.
 */
export function isWalkinUrgent(args: {
  joinedQueueAtIso: string;
  staffRequestNote: string | null;
  nowIso?: string;
}): boolean {
  if (minutesWaiting(args.joinedQueueAtIso, args.nowIso) >= 20) {
    return true;
  }
  const note = args.staffRequestNote ?? "";
  return URGENCY_KW.test(note);
}
