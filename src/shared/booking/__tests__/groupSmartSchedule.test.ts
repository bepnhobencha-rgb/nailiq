/**
 * Unit tests for the group smart schedule engine — pure functions only.
 *
 * Covers:
 *   1. sync_start (tryAlignedArrangement) — all members start at anchor
 *   2. sync_finish (tryFinishAlignedArrangement) — different starts, same finish
 *   3. sync_finish rejects target finish that puts any member before dayOpen
 *   4. sync_finish rejects staff capability mismatch
 *   5. findFinishArrangementsInWindow — best/alt/earliest dedup (Bug 4.A fix)
 *
 * Run:  npx tsx src/shared/booking/__tests__/groupSmartSchedule.test.ts
 */

import { buildCapabilityMap } from "../staffCapability";
import {
  tryAlignedArrangement as _tryAlignedArrangement,
  tryFinishAlignedArrangement as _tryFinishAlignedArrangement,
  findFinishArrangementsInWindow as _findFinishArrangementsInWindow,
  type ResolvedMember as _ResolvedMember,
  type StaffRow as _StaffRow,
  type ExistingBooking as _ExistingBooking,
  type FinishArrangementsCtx as _FinishArrangementsCtx,
} from "../groupSchedulerCore";

// ─── Tiny test harness ───────────────────────────────────────────

let pass = 0,
  fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`✓ ${name}`);
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

function assertNotNull<T>(v: T | null, msg?: string): T {
  if (v === null)
    throw new Error(msg ?? "Expected non-null but got null");
  return v;
}

function assertNull(v: unknown, msg?: string) {
  if (v !== null)
    throw new Error(
      `${msg ?? "Expected null but got"}: ${JSON.stringify(v)}`,
    );
}

function assertTrue(v: boolean, msg?: string) {
  if (!v) throw new Error(msg ?? "Expected true but got false");
}

// ─── Test fixtures ───────────────────────────────────────────────

const MIN = 60_000; // ms per minute

// A fixed "day" in UTC: 2030-06-15, salon open 09:00–20:00
const DAY_OPEN_MS = new Date("2030-06-15T09:00:00Z").getTime();
const DAY_CLOSE_MS = new Date("2030-06-15T20:00:00Z").getTime();
const TARGET_FINISH_MS = new Date("2030-06-15T12:00:00Z").getTime(); // noon

// Two staff members, each capable of every service (no capability whitelist
// → null capability map = all-capable fallback).
const STAFF: _StaffRow[] = [
  { id: "s1", name: "Alice" },
  { id: "s2", name: "Bob" },
];
const STAFF_BY_ID = new Map(STAFF.map((s) => [s.id, s]));

function member(
  index: number,
  totalMinutes: number,
  preferredStaffId: string | null = null,
  serviceId = "svc1",
): _ResolvedMember {
  return {
    index,
    name: `Member${index}`,
    serviceId,
    serviceName: "Test Service",
    totalMinutes,
    priceCents: null,
    preferredStaffId,
  };
}

// ─── 1. sync_start: tryAlignedArrangement ────────────────────────

test("sync_start — all members start at the anchor time", () => {
  const anchorMs = new Date("2030-06-15T10:00:00Z").getTime();
  const members = [member(0, 60), member(1, 30)];

  const result = assertNotNull(
    _tryAlignedArrangement(
      anchorMs,
      members,
      STAFF,
      STAFF_BY_ID,
      null, // null = all-capable
      [],
      true,
    ),
    "Expected successful arrangement",
  );

  assertEqual(result.assignments.length, 2, "should have 2 assignments");
  for (const a of result.assignments) {
    assertEqual(a.startMs, anchorMs, `member ${a.memberIdx} should start at anchor`);
  }
  // Each end time = anchorMs + their own duration
  const m0 = result.assignments.find((a) => a.memberIdx === 0)!;
  const m1 = result.assignments.find((a) => a.memberIdx === 1)!;
  assertEqual(m0.endMs, anchorMs + 60 * MIN, "60-min member ends +60 min");
  assertEqual(m1.endMs, anchorMs + 30 * MIN, "30-min member ends +30 min");
});

test("sync_start — single member falls back to s2 when s1 is busy", () => {
  const anchorMs = new Date("2030-06-15T10:00:00Z").getTime();
  // One member with no preference — staff tried in array order (s1 first, then s2)
  const members = [member(0, 60)];
  // s1 is fully booked at this slot
  const existing: _ExistingBooking[] = [
    { staffId: "s1", startMs: anchorMs, endMs: anchorMs + 120 * MIN },
  ];

  const result = assertNotNull(
    _tryAlignedArrangement(anchorMs, members, STAFF, STAFF_BY_ID, null, existing, true),
    "Should succeed by falling back to s2",
  );
  assertEqual(result.assignments[0].staffId, "s2", "should use s2 when s1 is busy");
});

test("sync_start — returns null when no staff is free", () => {
  const anchorMs = new Date("2030-06-15T10:00:00Z").getTime();
  const members = [member(0, 60), member(1, 30)];
  // Both staff booked all day
  const existing: _ExistingBooking[] = [
    { staffId: "s1", startMs: DAY_OPEN_MS, endMs: DAY_CLOSE_MS },
    { staffId: "s2", startMs: DAY_OPEN_MS, endMs: DAY_CLOSE_MS },
  ];

  assertNull(
    _tryAlignedArrangement(anchorMs, members, STAFF, STAFF_BY_ID, null, existing, true),
    "Should fail when no staff free",
  );
});

// ─── 2. sync_finish: tryFinishAlignedArrangement ─────────────────

test("sync_finish — members with different durations end at the same time", () => {
  const members = [member(0, 60), member(1, 30)];

  const result = assertNotNull(
    _tryFinishAlignedArrangement(
      TARGET_FINISH_MS,
      DAY_OPEN_MS,
      members,
      STAFF,
      STAFF_BY_ID,
      null,
      [],
      true,
    ),
    "Expected successful arrangement",
  );

  assertEqual(result.assignments.length, 2, "should have 2 assignments");
  for (const a of result.assignments) {
    assertEqual(a.endMs, TARGET_FINISH_MS, `member ${a.memberIdx} should end at target`);
  }

  const m0 = result.assignments.find((a) => a.memberIdx === 0)!;
  const m1 = result.assignments.find((a) => a.memberIdx === 1)!;

  // 60-min member starts 60 min before finish, 30-min member starts 30 min before
  assertEqual(
    m0.startMs,
    TARGET_FINISH_MS - 60 * MIN,
    "60-min member should start 60 min before target",
  );
  assertEqual(
    m1.startMs,
    TARGET_FINISH_MS - 30 * MIN,
    "30-min member should start 30 min before target",
  );
  assertTrue(m0.startMs !== m1.startMs, "start times should differ");
});

test("sync_finish — single-member group: start = targetFinish - duration", () => {
  const members = [member(0, 45)];

  const result = assertNotNull(
    _tryFinishAlignedArrangement(
      TARGET_FINISH_MS,
      DAY_OPEN_MS,
      members,
      STAFF,
      STAFF_BY_ID,
      null,
      [],
      true,
    ),
  );

  assertEqual(result.assignments[0].startMs, TARGET_FINISH_MS - 45 * MIN);
  assertEqual(result.assignments[0].endMs, TARGET_FINISH_MS);
});

// ─── 3. sync_finish rejects pre-opening starts ───────────────────

test("sync_finish — rejects if any member would start before dayOpen", () => {
  // targetFinish = 09:15, 60-min member would need to start at 08:15 < 09:00
  const earlyTarget = DAY_OPEN_MS + 15 * MIN; // 09:15
  const members = [member(0, 60)]; // needs to start at 08:15

  assertNull(
    _tryFinishAlignedArrangement(
      earlyTarget,
      DAY_OPEN_MS,
      members,
      STAFF,
      STAFF_BY_ID,
      null,
      [],
      true,
    ),
    "Should return null when start would be before dayOpen",
  );
});

test("sync_finish — accepts if all members start exactly at dayOpen", () => {
  // targetFinish = 09:00 + 60 min = 10:00; 60-min member starts exactly at 09:00
  const exactTarget = DAY_OPEN_MS + 60 * MIN;
  const members = [member(0, 60)];

  const result = _tryFinishAlignedArrangement(
    exactTarget,
    DAY_OPEN_MS,
    members,
    STAFF,
    STAFF_BY_ID,
    null,
    [],
    true,
  );

  assertNotNull(result, "Should succeed when start is exactly dayOpen");
  assertEqual(result!.assignments[0].startMs, DAY_OPEN_MS);
});

test("sync_finish — rejects if the SHORTER-service member starts before dayOpen", () => {
  // Longer member (60 min) would start at 09:30 — fine.
  // But a 3rd member with 70 min would need to start at 09:20 — fine.
  // Actual failing case: target = 09:25, member has 30 min → start = 08:55 < 09:00
  const earlyTarget = DAY_OPEN_MS + 25 * MIN; // 09:25
  const members = [
    member(0, 60), // start = 08:25 — also before open, fails first
    member(1, 30), // start = 08:55 — before open
  ];

  assertNull(
    _tryFinishAlignedArrangement(
      earlyTarget,
      DAY_OPEN_MS,
      members,
      STAFF,
      STAFF_BY_ID,
      null,
      [],
      true,
    ),
  );
});

// ─── 4. sync_finish rejects staff capability mismatch ───────────

test("sync_finish — returns null when no capable staff exists for a service", () => {
  // svc_special can only be done by s1.
  // Member 0 needs svc_special; member 1 also needs svc_special.
  // If s1 is already booked for member 0, member 1 has nobody.
  const capabilityRows = [
    { staff_id: "s1", service_id: "svc_special" },
    { staff_id: "s2", service_id: "svc_other" },
  ];
  const capability = buildCapabilityMap(capabilityRows);

  const members = [
    member(0, 30, null, "svc_special"),
    member(1, 30, null, "svc_special"), // also needs svc_special but s1 taken
  ];

  // Both members end at TARGET_FINISH_MS; both start at TARGET - 30 min.
  // They have the same slot — s1 can only serve one. s2 can't do svc_special.
  assertNull(
    _tryFinishAlignedArrangement(
      TARGET_FINISH_MS,
      DAY_OPEN_MS,
      members,
      STAFF,
      STAFF_BY_ID,
      capability,
      [],
      true,
    ),
    "Should return null when only one capable staff but two members need the same slot",
  );
});

test("sync_finish — returns null when no staff can perform the service", () => {
  const capabilityRows = [
    { staff_id: "s1", service_id: "svc_other" },
    { staff_id: "s2", service_id: "svc_other" },
    // nobody is whitelisted for svc_rare
  ];
  const capability = buildCapabilityMap(capabilityRows);
  const members = [member(0, 60, null, "svc_rare")];

  assertNull(
    _tryFinishAlignedArrangement(
      TARGET_FINISH_MS,
      DAY_OPEN_MS,
      members,
      STAFF,
      STAFF_BY_ID,
      capability,
      [],
      true,
    ),
    "Should return null when no staff is whitelisted for the service",
  );
});

// ─── 5. findFinishArrangementsInWindow ───────────────────────────

function makeCtx(overrides: Partial<_FinishArrangementsCtx> = {}): _FinishArrangementsCtx {
  return {
    targetFinishMs: TARGET_FINISH_MS,
    dayOpenMs: DAY_OPEN_MS,
    dayCloseMs: DAY_CLOSE_MS,
    date: "2030-06-15",
    timezone: "UTC",
    resolvedMembers: [member(0, 60), member(1, 30)],
    staffList: STAFF,
    staffById: STAFF_BY_ID,
    capability: null,
    existing: [],
    ...overrides,
  };
}

test("findFinishArrangementsInWindow — returns best arrangement at target time", () => {
  const results = _findFinishArrangementsInWindow(makeCtx());

  assertTrue(results.length >= 1, "Should return at least one arrangement");
  assertEqual(results[0].kind, "best", "First arrangement should be 'best'");
  // All assignments end at the same time
  for (const a of results[0].assignments) {
    assertEqual(a.endUtcIso, new Date(TARGET_FINISH_MS).toISOString());
  }
});

test("findFinishArrangementsInWindow — best arrangement has correct finish time", () => {
  const results = _findFinishArrangementsInWindow(makeCtx());
  const best = results.find((r) => r.kind === "best");
  assertNotNull(best, "best arrangement should exist");
  assertEqual(best!.groupEndMs, TARGET_FINISH_MS);
});

test("findFinishArrangementsInWindow — earliest not suppressed when it differs from best", () => {
  // targetFinish = late in the day (16:00). earliestFinish should be 10:00 (open=09:00, max=60min).
  // With no existing bookings, the earliest arrangement is at 10:00 ≠ 16:00, so it should appear.
  const lateTarget = new Date("2030-06-15T16:00:00Z").getTime();
  const results = _findFinishArrangementsInWindow(makeCtx({ targetFinishMs: lateTarget }));

  const earliest = results.find((r) => r.kind === "earliest");
  assertNotNull(earliest, "earliest arrangement should be present when target is late");
  assertTrue(
    earliest!.groupEndMs < lateTarget,
    "earliest finish time should be earlier than target",
  );
});

test("findFinishArrangementsInWindow — earliest not shown when it is truly same as best (same time + same staff)", () => {
  // targetFinish = earliest possible finish (09:00 + 60 = 10:00).
  // With one staff and no preferred staff, earliest == best (same time, same staff).
  const earliestPossibleTarget = DAY_OPEN_MS + 60 * MIN; // 10:00
  const singleStaff: _StaffRow[] = [{ id: "s1", name: "Alice" }];
  const singleStaffById = new Map([["s1", singleStaff[0]]]);

  const results = _findFinishArrangementsInWindow(
    makeCtx({
      targetFinishMs: earliestPossibleTarget,
      resolvedMembers: [member(0, 60)],
      staffList: singleStaff,
      staffById: singleStaffById,
    }),
  );

  // best should be at 10:00; earliest is ALSO at 10:00 with the same staff →
  // they are identical, no point showing earliest as a separate card.
  const best = results.find((r) => r.kind === "best");
  const earliest = results.find((r) => r.kind === "earliest");
  assertNotNull(best, "best should still be present");
  // earliest should NOT appear (same time AND same staff)
  if (earliest) {
    // If it does appear, staff assignments must differ (otherwise it's a dup)
    assertTrue(
      earliest.assignments.some(
        (a, i) => best!.assignments[i] && a.staffId !== best!.assignments[i].staffId,
      ),
      "If earliest appears alongside best at same finish time, staff must differ",
    );
  }
});

test("findFinishArrangementsInWindow — earliest IS shown when same finish time but different staff (Bug 4.A)", () => {
  // Two staff: s1 preferred for member 0.
  // Best (respectPreferred=true): assigns s1 to member 0.
  // Earliest (respectPreferred=false): on an otherwise-free day it finds the
  // SAME finish time as best (earliestFinish = dayOpen + 60 min = 10:00,
  // and target is also 10:00). With respectPreferred=false it may still assign
  // s1 first (s1 is just preference, not exclusive here), so this test
  // uses s1 as UNAVAILABLE for earliest by pre-booking s1 at the start.
  //
  // Setup: targetFinish = 10:00 = earliest possible.
  // s1 preferred for member 0.
  // s1 is busy ONLY for the respectPreferred=true attempt (we simulate by
  // having s1 already booked for a concurrent slot so that:
  //   - respectPreferred=true: tries s1, s1 busy → returns null (no best)
  //   - respectPreferred=false: tries ALL staff, s1 still busy, falls back to s2 → succeeds
  // This means best is null, earliest is present. Check earliest appears.

  const earliestPossibleTarget = DAY_OPEN_MS + 60 * MIN; // 10:00
  // s1 busy at 09:00–10:00 so they CAN'T serve member 0 at startMs=09:00
  const existing: _ExistingBooking[] = [
    { staffId: "s1", startMs: DAY_OPEN_MS, endMs: DAY_OPEN_MS + 60 * MIN },
  ];
  const members = [member(0, 60, "s1")]; // prefers s1 (which is blocked)

  const results = _findFinishArrangementsInWindow(
    makeCtx({
      targetFinishMs: earliestPossibleTarget,
      resolvedMembers: members,
      existing,
    }),
  );

  // Since s1 (preferred) is blocked:
  //   respectPreferred=true → no assignment → no best arrangement
  //   respectPreferred=false → s2 works → earliest at 10:00 should appear
  const earliest = results.find((r) => r.kind === "earliest");
  assertNotNull(
    earliest,
    "earliest should appear even when best is absent (s1 blocked, s2 free)",
  );
  assertEqual(
    earliest!.assignments[0].staffId,
    "s2",
    "earliest should use s2 (s1 was blocked)",
  );
});

test("findFinishArrangementsInWindow — returns empty when no valid finish time exists", () => {
  // All staff booked the entire day
  const existing: _ExistingBooking[] = [
    { staffId: "s1", startMs: DAY_OPEN_MS, endMs: DAY_CLOSE_MS },
    { staffId: "s2", startMs: DAY_OPEN_MS, endMs: DAY_CLOSE_MS },
  ];

  const results = _findFinishArrangementsInWindow(makeCtx({ existing }));
  assertEqual(results.length, 0, "should return no arrangements when all staff booked");
});

test("findFinishArrangementsInWindow — returns empty when dayClose <= earliestFinish", () => {
  // dayClose set to before the earliest possible finish
  const results = _findFinishArrangementsInWindow(
    makeCtx({ dayCloseMs: DAY_OPEN_MS + 30 * MIN }), // closes 30 min after open, but max service is 60 min
  );
  assertEqual(results.length, 0, "should return no arrangements when salon closes before earliest finish");
});

// ─────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
