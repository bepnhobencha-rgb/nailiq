/**
 * Regression test for the group day-timeline preview (loadGroupDayTimeline.ts)
 * respecting an explicit preferred staff — pure functions only, no DB.
 *
 * Bug covered: the timeline used to check "is ANY capable staff free",
 * ignoring a member's preferred-staff pick. That could show a tick as
 * available when the requested staff was actually busy, so tapping it
 * could silently assign a different tech than the receptionist chose.
 * Fixed by threading preferredStaffId through and sweeping with
 * respectPreferred=true (see loadGroupDayTimeline.ts).
 *
 * Run:  npx tsx src/shared/booking/__tests__/loadGroupDayTimeline.test.ts
 */

import {
  tryAlignedArrangement as _tryAlignedArrangement,
  type ResolvedMember as _ResolvedMember,
  type StaffRow as _StaffRow,
  type ExistingBooking as _ExistingBooking,
} from "../groupSchedulerCore";

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

function assertNull(v: unknown, msg?: string) {
  if (v !== null) throw new Error(`${msg ?? "Expected null but got"}: ${JSON.stringify(v)}`);
}

function assertNotNull<T>(v: T | null, msg?: string): T {
  if (v === null) throw new Error(msg ?? "Expected non-null but got null");
  return v;
}

const MIN = 60_000;
const TICK_MS = new Date("2030-06-15T15:30:00Z").getTime();

// Three staff, all capable of every service (null capability = all-capable
// fallback). Three (not two) so a 2-person group still has a free DISTINCT
// staff per member after Anna is marked busy — otherwise the "Any" case
// would correctly fail for an unrelated reason (only 1 staff left for 2
// simultaneous members) rather than demonstrating the preferred-staff fix.
const STAFF: _StaffRow[] = [
  { id: "anna", name: "Anna" },
  { id: "bella", name: "Bella" },
  { id: "chloe", name: "Chloe" },
];
const STAFF_BY_ID = new Map(STAFF.map((s) => [s.id, s]));

function twoPersonGroup(preferredStaffId: string | null): _ResolvedMember[] {
  return [
    {
      index: 0,
      name: "",
      serviceId: "svc1",
      serviceName: "",
      totalMinutes: 65,
      priceCents: null,
      preferredStaffId,
    },
    {
      index: 1,
      name: "",
      serviceId: "svc1",
      serviceName: "",
      totalMinutes: 65,
      priceCents: null,
      preferredStaffId: null,
    },
  ];
}

// Anna is busy exactly at the tick; Bella is free.
const ANNA_BUSY: _ExistingBooking[] = [
  { staffId: "anna", startMs: TICK_MS, endMs: TICK_MS + 60 * MIN },
];

test("preferred staff busy + respectPreferred=true → tick is infeasible", () => {
  const result = _tryAlignedArrangement(
    TICK_MS,
    twoPersonGroup("anna"),
    STAFF,
    STAFF_BY_ID,
    null,
    ANNA_BUSY,
    true,
  );
  assertNull(result, "should be infeasible — the explicitly requested staff is busy");
});

test('member left on "Any" + respectPreferred=true → tick stays feasible (other staff free)', () => {
  const result = _tryAlignedArrangement(
    TICK_MS,
    twoPersonGroup(null),
    STAFF,
    STAFF_BY_ID,
    null,
    ANNA_BUSY,
    true,
  );
  assertNotNull(result, 'should be feasible — "Any" falls back to Bella');
});

test("regression guard: respectPreferred=false would have hidden the busy preferred staff (the original bug)", () => {
  const result = _tryAlignedArrangement(
    TICK_MS,
    twoPersonGroup("anna"),
    STAFF,
    STAFF_BY_ID,
    null,
    ANNA_BUSY,
    false,
  );
  assertNotNull(
    result,
    "documents the bug: with respectPreferred=false this incorrectly reports feasible even though the requested staff is busy — loadGroupDayTimeline.ts must always pass true",
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
