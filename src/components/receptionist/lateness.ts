/**
 * Lateness-escalation tier for confirmed/pending bookings past their start time.
 * Drives the grid visual (ring color, badge, countdown) and the inline Start button.
 * The visual tier is derived live. At the configured threshold, the cron
 * persists a review-candidate flag but never changes status or charges.
 */
export type LatenessTier = "due" | "late" | "critical" | null;

export interface LatenessResult {
  tier: LatenessTier;
  minutesLate: number;
  /** ISO string of when the booking becomes due for desk review. */
  autoAtIso: string | null;
}

export function computeLatenessTier(args: {
  status: string;
  startTimeUtc: string;
  nowIso: string;
  autoNoShowMinutes: number | null;
}): LatenessResult {
  const { status, startTimeUtc, nowIso, autoNoShowMinutes } = args;

  // Only applies to not-yet-started statuses
  if (status !== "confirmed" && status !== "pending") {
    return { tier: null, minutesLate: 0, autoAtIso: null };
  }

  const startMs = Date.parse(startTimeUtc);
  const nowMs = Date.parse(nowIso);

  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) {
    return { tier: null, minutesLate: 0, autoAtIso: null };
  }

  const minutesLate = (nowMs - startMs) / 60_000;
  if (minutesLate < 0) {
    return { tier: null, minutesLate: 0, autoAtIso: null };
  }

  const T =
    typeof autoNoShowMinutes === "number" && autoNoShowMinutes > 0
      ? autoNoShowMinutes
      : null;

  let tier: LatenessTier;
  let autoAtIso: string | null = null;

  if (T !== null) {
    // Auto mode: milestones relative to T
    autoAtIso = new Date(startMs + T * 60_000).toISOString();
    if (minutesLate < T / 3) {
      tier = "due";
    } else if (minutesLate < T - 5) {
      tier = "late";
    } else {
      tier = "critical";
    }
  } else {
    // Manual mode: fixed milestones
    if (minutesLate < 10) {
      tier = "due";
    } else if (minutesLate < 20) {
      tier = "late";
    } else {
      tier = "critical";
    }
  }

  return { tier, minutesLate, autoAtIso };
}
