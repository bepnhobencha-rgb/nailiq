/**
 * Unit tests for inferReturnCadenceDays — the shared return-rhythm cadence
 * used by both the booking drawer launchpad and the Customer 360 pattern card.
 *
 * Run: npx tsx src/shared/booking/__tests__/returnRhythm.test.ts
 */

import { inferReturnCadenceDays, median } from "../returnRhythm";

let pass = 0,
  fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `expected ${b}, got ${a}`);
}

// Build an ISO `daysAgo`-style sequence from a base date (UTC noon to avoid tz edges).
const base = Date.parse("2026-01-01T20:00:00Z");
const iso = (dayOffset: number) =>
  new Date(base + dayOffset * 86_400_000).toISOString();

test("median: odd + even", () => {
  eq(median([3]), 3);
  eq(median([1, 2, 3]), 2);
  eq(median([2, 4]), 3); // rounded
  eq(median([]), null);
});

test("null when fewer than 3 distinct visit days", () => {
  eq(inferReturnCadenceDays([{ start: iso(0) }, { start: iso(28) }]), null);
});

test("clean 28-day rhythm → 28", () => {
  const v = [0, 28, 56, 84].map((d) => ({ start: iso(d), status: "completed" }));
  eq(inferReturnCadenceDays(v), 28);
});

test("21-day rhythm → 21 (≈3 weeks)", () => {
  const v = [0, 21, 42].map((d) => ({ start: iso(d), status: "confirmed" }));
  eq(inferReturnCadenceDays(v), 21);
});

test("cancelled + pending rows excluded", () => {
  const v = [
    { start: iso(0), status: "completed" },
    { start: iso(30), status: "cancelled" }, // ignored
    { start: iso(60), status: "pending" }, // ignored
    { start: iso(28), status: "completed" },
    { start: iso(56), status: "no_show" },
  ];
  // Real days: 0, 28, 56 → gaps 28,28 → 28
  eq(inferReturnCadenceDays(v), 28);
});

test("same-day multi-service does NOT fake a 0-day rhythm", () => {
  const v = [
    { start: iso(0), status: "completed" },
    { start: iso(0), status: "completed" }, // same day → deduped
    { start: iso(0), status: "completed" },
  ];
  eq(inferReturnCadenceDays(v), null); // only 1 distinct day
});

test("lapse > 183 days ignored in the gap set", () => {
  // days 0, 14, 28, then a 300-day gap to 328 → that gap dropped,
  // remaining gaps 14,14 → 14
  const v = [0, 14, 28, 328].map((d) => ({ start: iso(d), status: "completed" }));
  eq(inferReturnCadenceDays(v), 14);
});

test("missing/blank start values are skipped", () => {
  const v = [
    { start: null, status: "completed" },
    { start: iso(0), status: "completed" },
    { start: iso(28), status: "completed" },
    { start: iso(56), status: "completed" },
  ];
  eq(inferReturnCadenceDays(v), 28);
});

console.log(`\nreturnRhythm: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
