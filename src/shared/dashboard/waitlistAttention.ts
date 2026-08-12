export type WaitlistAttentionEntry = {
  status: string;
  createdAt: string;
};

export type WaitlistAttentionSummary = {
  total: number;
  waiting: number;
  claimed: number;
  oldestWaitingMinutes: number | null;
};

/**
 * Whole minutes elapsed since a Waitlist request was created.
 *
 * Invalid timestamps stay unknown instead of becoming a misleading urgency
 * value. Future timestamps are clamped to zero so small clock skew never
 * displays a negative wait.
 */
export function waitlistAgeMinutes(
  createdAt: string | null | undefined,
  observedAtIso: string,
): number | null {
  if (!createdAt) return null;
  const createdMs = Date.parse(createdAt);
  const observedMs = Date.parse(observedAtIso);
  if (!Number.isFinite(createdMs) || !Number.isFinite(observedMs)) return null;
  return Math.max(0, Math.floor((observedMs - createdMs) / 60_000));
}

/**
 * Deterministic Waitlist snapshot shared by the Front Desk and Owner Pulse.
 * The function contains no PII and performs no I/O, which keeps urgency copy
 * consistent without adding an AI call.
 */
export function summarizeWaitlistAttention(
  entries: readonly WaitlistAttentionEntry[],
  observedAtIso: string,
): WaitlistAttentionSummary {
  let waiting = 0;
  let claimed = 0;
  let oldestWaitingMinutes: number | null = null;

  for (const entry of entries) {
    if (entry.status === "claimed") claimed += 1;
    if (entry.status !== "waiting") continue;
    waiting += 1;
    const age = waitlistAgeMinutes(entry.createdAt, observedAtIso);
    if (age === null) continue;
    oldestWaitingMinutes =
      oldestWaitingMinutes === null ? age : Math.max(oldestWaitingMinutes, age);
  }

  return {
    total: entries.length,
    waiting,
    claimed,
    oldestWaitingMinutes,
  };
}
