/**
 * slotScoring.ts — Pure slot-scoring logic for Smart Gap-Free Scheduling (Phase 5).
 *
 * No DB calls, no `Date.now()`. Fully deterministic and unit-testable.
 *
 * Scoring rules (per staff member):
 *   +100 "best_fit"    — slot fills the EXACT gap between two existing bookings
 *                        (slot.start == prevBooking.end && slot.end == nextBooking.start)
 *   +80  "recommended" — slot starts exactly when a prior booking ends (back-to-back after),
 *                        OR ends exactly when the next booking starts (back-to-back before),
 *                        but NOT a perfect fill
 *   -40  per side      — slot creates a dead gap: gap > 0 but < shortest bookable service
 *                        (i.e. an unusable sliver of time the salon can't fill)
 *
 * Label visibility rule: only show a label when finalScore >= 80.
 *
 * "Any-staff" mode: score each capable staff member independently and keep the BEST score
 * (the actual staff assignment happens at submit time via pickBestStaffAmongFree).
 */

import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import type { BookingStaffItem } from "@/shared/booking/loadBookingServices";

// ─── Types ────────────────────────────────────────────────────────

export type SlotScoringLabel = "best_fit" | "recommended" | null;

export type SlotScore = {
  /** Numeric score ≥ 0. 0 = neutral (no smart scheduling signal). */
  score: number;
  /** UI label. null when score < 80 or no meaningful signal. */
  scoringLabel: SlotScoringLabel;
};

interface OccInterval {
  startMs: number;
  endMs: number;
}

// ─── Core per-staff scorer ─────────────────────────────────────────

/**
 * Score a slot against a SINGLE staff member's booking intervals.
 *
 * @param slotStartMs         Slot start in epoch-ms
 * @param slotEndMs           Slot end in epoch-ms (start + service duration)
 * @param staffBookings       All bookings for this staff member (any day is fine —
 *                            only intervals that neighbour the slot are examined)
 * @param shortestServiceMs   Shortest bookable service for this salon in ms.
 *                            Pass 0 to skip the dead-gap penalty entirely.
 */
export function scoreSlotForStaff(
  slotStartMs: number,
  slotEndMs: number,
  staffBookings: readonly OccInterval[],
  shortestServiceMs: number,
): SlotScore {
  // Find the CLOSEST previous booking end that is ≤ slotStart.
  let prevEnd: number | null = null;
  // Find the CLOSEST next booking start that is ≥ slotEnd.
  let nextStart: number | null = null;

  for (const b of staffBookings) {
    if (b.endMs <= slotStartMs) {
      if (prevEnd === null || b.endMs > prevEnd) prevEnd = b.endMs;
    }
    if (b.startMs >= slotEndMs) {
      if (nextStart === null || b.startMs < nextStart) nextStart = b.startMs;
    }
  }

  // ── Positive scores ───────────────────────────────────────────────
  const backToBackAfter  = prevEnd   !== null && prevEnd   === slotStartMs;
  const backToBackBefore = nextStart !== null && nextStart === slotEndMs;

  let score: number;
  let scoringLabel: SlotScoringLabel;

  if (backToBackAfter && backToBackBefore) {
    // Perfect gap fill — slot lands exactly in the gap between two bookings.
    score = 100;
    scoringLabel = "best_fit";
  } else if (backToBackAfter || backToBackBefore) {
    score = 80;
    scoringLabel = "recommended";
  } else {
    score = 0;
    scoringLabel = null;
  }

  // ── Dead-gap penalty (conservative) ──────────────────────────────
  // Only penalise when the gap is strictly between 0 (exclusive) and
  // shortestServiceMs (exclusive).  A gap of 0 is back-to-back (good).
  // A gap ≥ shortestServiceMs is usable (no penalty).
  if (shortestServiceMs > 0) {
    // Left gap: space between previous booking end and this slot start.
    const leftGapMs =
      prevEnd !== null && slotStartMs > prevEnd ? slotStartMs - prevEnd : 0;
    if (leftGapMs > 0 && leftGapMs < shortestServiceMs) {
      score -= 40;
    }

    // Right gap: space between this slot end and next booking start.
    const rightGapMs =
      nextStart !== null && nextStart > slotEndMs ? nextStart - slotEndMs : 0;
    if (rightGapMs > 0 && rightGapMs < shortestServiceMs) {
      score -= 40;
    }
  }

  // ── Label visibility threshold ────────────────────────────────────
  // Only surface a label when the score is still meaningfully positive.
  const finalScore = Math.max(0, score);
  if (finalScore < 80) scoringLabel = null;

  return { score: finalScore, scoringLabel };
}

// ─── Top-level scorer (handles any-staff routing) ────────────────

/**
 * Score a slot, routing to per-staff scoring.
 *
 * For "any-staff" bookings: scores each capable staff member and returns
 * the BEST result (highest score wins — best-case assignment at submit time).
 *
 * @param slotStartMs         Slot start epoch-ms
 * @param slotEndMs           Slot end epoch-ms
 * @param staffId             Selected staff UUID, or BOOKING_ANY_STAFF_ID
 * @param staffList           All capable staff for this service
 * @param allOccIntervals     All occupancy intervals with their staff_id
 * @param shortestServiceMs   Shortest salon service in ms (0 = skip dead-gap penalty)
 */
export function scoreSlot(
  slotStartMs: number,
  slotEndMs: number,
  staffId: string,
  staffList: readonly BookingStaffItem[],
  allOccIntervals: readonly { staffId: string; startMs: number; endMs: number }[],
  shortestServiceMs: number,
): SlotScore {
  if (staffId !== BOOKING_ANY_STAFF_ID) {
    const staffBookings = allOccIntervals
      .filter((o) => o.staffId === staffId)
      .map((o) => ({ startMs: o.startMs, endMs: o.endMs }));
    return scoreSlotForStaff(slotStartMs, slotEndMs, staffBookings, shortestServiceMs);
  }

  // Any-staff: take the best possible score across capable staff members.
  let best: SlotScore = { score: 0, scoringLabel: null };
  for (const s of staffList) {
    const staffBookings = allOccIntervals
      .filter((o) => o.staffId === s.id)
      .map((o) => ({ startMs: o.startMs, endMs: o.endMs }));
    const candidate = scoreSlotForStaff(
      slotStartMs,
      slotEndMs,
      staffBookings,
      shortestServiceMs,
    );
    if (candidate.score > best.score) best = candidate;
  }
  return best;
}
