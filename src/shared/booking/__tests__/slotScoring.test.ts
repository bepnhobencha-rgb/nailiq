/**
 * Phase 5 — Smart Gap-Free Scheduling unit tests.
 *
 * Run: npx tsx src/shared/booking/__tests__/slotScoring.test.ts
 *
 * Tests cover the pure slotScoring.ts logic:
 *   1.  Perfect gap fill → score 100, label "best_fit"
 *   2.  Back-to-back after → score 80, label "recommended"
 *   3.  Back-to-back before → score 80, label "recommended"
 *   4.  Dead gap penalty reduces score (single gap)
 *   5.  Dead gap penalty reduces score (both gaps)
 *   6.  Label cleared when score drops below 80 after penalty
 *   7.  Neutral slot (no neighbours) → score 0, no label
 *   8.  shortestServiceMs = 0 → no dead-gap penalty ever
 *   9.  Gap exactly equal to shortestService → no penalty
 *  10.  Gap > shortestService → no penalty
 *  11.  Any-staff: takes best score across staff members
 *  12.  Any-staff: neutral when all staff have neutral slots
 *  13.  scoreSlot (router) delegates to per-staff scorer for specific staff
 */

let pass = 0, fail = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(() => { pass++; console.log(`✓ ${name}`); })
       .catch((e: unknown) => { fail++; console.error(`✗ ${name}`); console.error(e); });
    } else {
      pass++;
      console.log(`✓ ${name}`);
    }
  } catch (e) {
    fail++;
    console.error(`✗ ${name}`);
    console.error(e);
  }
}

function assertEqual(actual: unknown, expected: unknown, msg?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ?? ""}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function assertTruthy(v: unknown, msg?: string) {
  if (!v) throw new Error(msg ?? `Expected truthy, got: ${JSON.stringify(v)}`);
}

import { scoreSlotForStaff, scoreSlot } from "../slotScoring";
import { BOOKING_ANY_STAFF_ID } from "../bookingStaffConstants";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build epoch-ms from hour:min on an arbitrary fixed date (2030-06-01). */
function hm(hour: number, min: number): number {
  return new Date(2030, 5, 1, hour, min, 0, 0).getTime();
}

const SHORTEST_30_MIN = 30 * 60_000; // shortest service = 30 min

// ─── scoreSlotForStaff ───────────────────────────────────────────────────────

test("1. Perfect gap fill → score 100, label 'best_fit'", () => {
  // Bookings: 9:00–9:45 and 10:30–11:00. New slot: 9:45–10:30 (45 min).
  const result = scoreSlotForStaff(
    hm(9, 45), hm(10, 30),
    [
      { startMs: hm(9, 0), endMs: hm(9, 45) },
      { startMs: hm(10, 30), endMs: hm(11, 0) },
    ],
    SHORTEST_30_MIN,
  );
  assertEqual(result.score, 100, "perfect fill should score 100");
  assertEqual(result.scoringLabel, "best_fit", "should be best_fit");
});

test("2. Back-to-back after (no next booking) → score 80, label 'recommended'", () => {
  // Booking: 9:00–9:45. New slot: 9:45–10:30.
  const result = scoreSlotForStaff(
    hm(9, 45), hm(10, 30),
    [{ startMs: hm(9, 0), endMs: hm(9, 45) }],
    SHORTEST_30_MIN,
  );
  assertEqual(result.score, 80);
  assertEqual(result.scoringLabel, "recommended");
});

test("3. Back-to-back before (no previous booking) → score 80, label 'recommended'", () => {
  // Booking: 10:30–11:15. New slot: 9:45–10:30.
  const result = scoreSlotForStaff(
    hm(9, 45), hm(10, 30),
    [{ startMs: hm(10, 30), endMs: hm(11, 15) }],
    SHORTEST_30_MIN,
  );
  assertEqual(result.score, 80);
  assertEqual(result.scoringLabel, "recommended");
});

test("4. Dead gap penalty (single right gap, 20 min < 30 min shortest) → score reduced", () => {
  // Booking: 9:00–9:45. New slot: 9:45–10:30. Next booking: 10:50–11:30.
  // Right gap = 10:50 − 10:30 = 20 min < 30 min → -40 penalty.
  // Initial B2B after = 80. After penalty: 80 - 40 = 40 → label cleared.
  const result = scoreSlotForStaff(
    hm(9, 45), hm(10, 30),
    [
      { startMs: hm(9, 0),  endMs: hm(9, 45) },
      { startMs: hm(10, 50), endMs: hm(11, 30) },
    ],
    SHORTEST_30_MIN,
  );
  assertEqual(result.score, 40, "score should be 80 - 40 = 40 after penalty");
  assertEqual(result.scoringLabel, null, "label should be cleared when score < 80");
});

test("5. Dead gap on neutral slot → score stays 0 (no negative display)", () => {
  // No bookings adjacent to slot. Dead gap penalty on left/right, but base is 0.
  // Prev booking ends at 9:00, slot at 9:20. Gap = 20 min < 30 → penalty.
  // But score clamped at 0.
  const result = scoreSlotForStaff(
    hm(9, 20), hm(10, 0),
    [
      { startMs: hm(8, 0), endMs: hm(9, 0) },
    ],
    SHORTEST_30_MIN,
  );
  assertEqual(result.score, 0, "neutral with dead gap should clamp to 0");
  assertEqual(result.scoringLabel, null);
});

test("6. Label cleared when B2B + penalty drops score below 80", () => {
  // B2B after (80) + one dead gap (-40) = 40 < 80 → label = null.
  // Left gap: 0 (B2B). Right gap: 15 min < 30 min.
  const result = scoreSlotForStaff(
    hm(9, 45), hm(10, 30),
    [
      { startMs: hm(9, 0),  endMs: hm(9, 45) },   // B2B after
      { startMs: hm(10, 45), endMs: hm(11, 0) },   // creates 15-min right gap
    ],
    SHORTEST_30_MIN,
  );
  assertTruthy(result.score < 80, `score should be < 80, got ${result.score}`);
  assertEqual(result.scoringLabel, null);
});

test("7. Neutral slot (no bookings) → score 0, no label", () => {
  const result = scoreSlotForStaff(hm(10, 0), hm(10, 45), [], SHORTEST_30_MIN);
  assertEqual(result.score, 0);
  assertEqual(result.scoringLabel, null);
});

test("8. shortestServiceMs = 0 → no dead-gap penalty ever applied", () => {
  // 20-min gap would normally trigger -40 penalty, but shortestServiceMs=0 disables it.
  // B2B after (80) + right gap of 20 min, but no penalty → score stays 80.
  const result = scoreSlotForStaff(
    hm(9, 45), hm(10, 30),
    [
      { startMs: hm(9, 0),  endMs: hm(9, 45) },
      { startMs: hm(10, 50), endMs: hm(11, 30) },
    ],
    0, // shortestServiceMs = 0 → no dead-gap penalty
  );
  assertEqual(result.score, 80, "no penalty when shortestServiceMs=0");
  assertEqual(result.scoringLabel, "recommended");
});

test("9. Gap exactly equal to shortestService → NO penalty", () => {
  // Gap = exactly 30 min. Condition is strictly < shortestServiceMs. No penalty.
  const result = scoreSlotForStaff(
    hm(9, 45), hm(10, 30),
    [
      { startMs: hm(9, 0), endMs: hm(9, 45) },   // B2B after
      { startMs: hm(11, 0), endMs: hm(11, 30) }, // gap = 30 min exactly
    ],
    SHORTEST_30_MIN, // = 30 min
  );
  // Right gap = 30 min >= 30 min shortest → no penalty.
  assertEqual(result.score, 80);
  assertEqual(result.scoringLabel, "recommended");
});

test("10. Gap larger than shortestService → no penalty", () => {
  // Right gap = 45 min >= 30 min shortest → no penalty.
  const result = scoreSlotForStaff(
    hm(9, 45), hm(10, 30),
    [
      { startMs: hm(9, 0),   endMs: hm(9, 45) },
      { startMs: hm(11, 15), endMs: hm(12, 0) },
    ],
    SHORTEST_30_MIN,
  );
  assertEqual(result.score, 80);
  assertEqual(result.scoringLabel, "recommended");
});

// ─── scoreSlot (any-staff routing) ──────────────────────────────────────────

const STAFF_S1 = { id: "s1", name: "Jenny", job_role: "nail_tech" };
const STAFF_S2 = { id: "s2", name: "Mai",   job_role: "nail_tech" };

test("11. Any-staff: picks best score across staff members", () => {
  // s1 has a B2B gap (score 80), s2 has neutral (score 0).
  // Any-staff should return score 80.
  const result = scoreSlot(
    hm(9, 45), hm(10, 30),
    BOOKING_ANY_STAFF_ID,
    [STAFF_S1, STAFF_S2],
    [
      { staffId: "s1", startMs: hm(9, 0), endMs: hm(9, 45) },   // s1 B2B
      // s2 has no relevant bookings
    ],
    SHORTEST_30_MIN,
  );
  assertEqual(result.score, 80);
  assertEqual(result.scoringLabel, "recommended");
});

test("12. Any-staff: returns neutral when ALL staff have neutral slots", () => {
  const result = scoreSlot(
    hm(10, 0), hm(10, 45),
    BOOKING_ANY_STAFF_ID,
    [STAFF_S1, STAFF_S2],
    [], // no bookings for anyone
    SHORTEST_30_MIN,
  );
  assertEqual(result.score, 0);
  assertEqual(result.scoringLabel, null);
});

test("13. Specific-staff: delegates correctly to per-staff scorer", () => {
  // s1 has B2B gap (score 80). We ask for s1 specifically.
  const result = scoreSlot(
    hm(9, 45), hm(10, 30),
    "s1",
    [STAFF_S1, STAFF_S2],
    [
      { staffId: "s1", startMs: hm(9, 0), endMs: hm(9, 45) },
      { staffId: "s2", startMs: hm(9, 0), endMs: hm(9, 45) }, // s2 also B2B — irrelevant
    ],
    SHORTEST_30_MIN,
  );
  assertEqual(result.score, 80);
  assertEqual(result.scoringLabel, "recommended");
});

// ─── Summary ────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}, 200);
