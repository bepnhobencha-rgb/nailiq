/**
 * Unit tests for the Phase 6 wave scheduler (tryWaveArrangement +
 * buildWaveArrangement) — pure functions only.
 *
 * Covers:
 *   - over-capacity group splits into the right number of waves
 *   - wave N+1 starts flush against wave N's latest block end (buffer is in the
 *     block, never double-counted between waves)
 *   - no staff is ever double-booked across waves
 *   - capability is respected per wave
 *   - infeasible service (no capable staff) returns null
 *   - buildWaveArrangement flags isWaveBooking / waveCount / per-assignment wave
 *   - a group that fits at once yields a single non-wave arrangement
 *
 * Run:  npx tsx src/shared/booking/__tests__/waveScheduler.test.ts
 */
import { buildCapabilityMap } from "../staffCapability";
import {
  tryAlignedArrangement,
  tryWaveArrangement,
  findEarliestWaveArrangement,
  buildWaveArrangement,
  SLOT_STEP_MIN,
  type ResolvedMember,
  type StaffRow,
  type ExistingBooking,
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
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEqual(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? ""}\n  expected: ${JSON.stringify(b)}\n  actual:   ${JSON.stringify(a)}`);
  }
}

const TZ = "America/Los_Angeles";
const SVC = "svc-1";
const MIN = 60_000;
const DUR = 60; // each service 60 min
const T0 = 0; // anchor at epoch — keeps the wave-timing math easy to read
const DAY_CLOSE = 24 * 60 * MIN;

const staff3: StaffRow[] = [
  { id: "S1", name: "Anna" },
  { id: "S2", name: "Tina" },
  { id: "S3", name: "Mai" },
];
const staffById3 = new Map(staff3.map((s) => [s.id, s]));

function members(n: number, serviceId = SVC): ResolvedMember[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    name: `Guest ${i + 1}`,
    serviceId,
    serviceName: "Test Service",
    totalMinutes: DUR,
    priceCents: 3000,
    preferredStaffId: null,
  }));
}

// ── Entry condition: over-capacity simultaneous arrangement is infeasible ──
test("tryAlignedArrangement returns null when group exceeds staff (the wave trigger)", () => {
  const res = tryAlignedArrangement(T0, members(7), staff3, staffById3, null, [], false);
  assert(res === null, "7 members / 3 staff cannot start simultaneously");
});

// ── 7 members / 3 staff → 3 waves (3 + 3 + 1) ──
test("7 members / 3 staff split into 3 waves of 3, 3, 1", () => {
  const res = tryWaveArrangement(T0, members(7), staff3, staffById3, null, [], DAY_CLOSE);
  assert(res !== null, "wave arrangement must be feasible");
  const a = res!.assignments;
  assertEqual(a.length, 7, "all 7 members seated");

  const byWave = (w: number) => a.filter((x) => x.waveNumber === w);
  assertEqual(byWave(1).length, 3, "wave 1 has 3");
  assertEqual(byWave(2).length, 3, "wave 2 has 3");
  assertEqual(byWave(3).length, 1, "wave 3 has 1");
});

// ── wave N+1 starts FLUSH against wave N's latest block end ──
test("each wave starts flush at the previous wave's block end", () => {
  const res = tryWaveArrangement(T0, members(7), staff3, staffById3, null, [], DAY_CLOSE)!;
  const a = res.assignments;
  // Blocks are flush by default: the per-service buffer is baked into the block
  // (totalMinutes), so the next wave starts the instant the previous one ends.
  const wave1Start = T0;
  const wave2Start = wave1Start + DUR * MIN;
  const wave3Start = wave2Start + DUR * MIN;

  for (const x of a.filter((y) => y.waveNumber === 1)) assertEqual(x.startMs, wave1Start, "wave1 start");
  for (const x of a.filter((y) => y.waveNumber === 2)) assertEqual(x.startMs, wave2Start, "wave2 start");
  for (const x of a.filter((y) => y.waveNumber === 3)) assertEqual(x.startMs, wave3Start, "wave3 start");
});

// ── No staff double-booking across all waves ──
test("no staff is double-booked across waves", () => {
  const res = tryWaveArrangement(T0, members(7), staff3, staffById3, null, [], DAY_CLOSE)!;
  const a = res.assignments;
  const byStaff = new Map<string, Array<{ s: number; e: number }>>();
  for (const x of a) {
    const arr = byStaff.get(x.staffId) ?? [];
    arr.push({ s: x.startMs, e: x.endMs });
    byStaff.set(x.staffId, arr);
  }
  for (const [sid, ivs] of byStaff) {
    ivs.sort((p, q) => p.s - q.s);
    for (let i = 1; i < ivs.length; i++) {
      assert(ivs[i].s >= ivs[i - 1].e, `staff ${sid} intervals overlap`);
    }
  }
});

// ── Capability respected: a svc-2 member only S2 can do ──
test("wave scheduler respects staff capability", () => {
  const cap = buildCapabilityMap([
    { staff_id: "S1", service_id: SVC },
    { staff_id: "S2", service_id: SVC },
    { staff_id: "S2", service_id: "svc-2" },
    { staff_id: "S3", service_id: SVC },
  ]);
  const ms = members(3); // 3 × svc-1
  ms.push({ index: 3, name: "Guest 4", serviceId: "svc-2", serviceName: "Special", totalMinutes: DUR, priceCents: 4000, preferredStaffId: null });
  const res = tryWaveArrangement(T0, ms, staff3, staffById3, cap, [], DAY_CLOSE)!;
  assert(res !== null, "feasible with capability");
  const special = res.assignments.find((x) => x.memberIdx === 3)!;
  assertEqual(special.staffId, "S2", "svc-2 member must go to the only capable staff S2");
});

// ── Infeasible: a service nobody can do → null ──
test("returns null when a service has no capable staff", () => {
  const cap = buildCapabilityMap([{ staff_id: "S1", service_id: SVC }]); // nobody does svc-x
  const ms = members(1, "svc-x");
  const res = tryWaveArrangement(T0, ms, staff3, staffById3, cap, [], DAY_CLOSE);
  assert(res === null, "unservable service yields null");
});

// ── buildWaveArrangement shape ──
test("buildWaveArrangement flags isWaveBooking + per-assignment waveNumber", () => {
  const raw = tryWaveArrangement(T0, members(7), staff3, staffById3, null, [], DAY_CLOSE)!;
  const arr = buildWaveArrangement(raw, members(7), staffById3, TZ);
  assertEqual(arr.isWaveBooking, true, "isWaveBooking");
  assertEqual(arr.waveCount, 3, "waveCount");
  assertEqual(arr.waves.length, 3, "waves rollup length");
  assertEqual(arr.waves.map((w) => w.memberCount), [3, 3, 1], "per-wave counts");
  assert(arr.assignments.every((x) => x.waveNumber >= 1 && x.waveNumber <= 3), "every assignment tagged with a wave");
  assert(/Split into 3 waves/.test(arr.summary), `summary mentions waves: ${arr.summary}`);
});

// ── Fits at once → single (non-wave) arrangement ──
test("group that fits simultaneously is not a wave booking", () => {
  const raw = tryWaveArrangement(T0, members(3), staff3, staffById3, null, [], DAY_CLOSE)!;
  const arr = buildWaveArrangement(raw, members(3), staffById3, TZ);
  assertEqual(arr.isWaveBooking, false, "3 members / 3 staff = single wave");
  assertEqual(arr.waveCount, 1, "one wave");
});

// ── Waves are flush: the per-service buffer is in the block, NOT added again ──
// Regression guard for the "back-to-back = 5 min but between waves = 10 min"
// double-count: bufferMinutes must NOT push wave N+1 out, because that buffer is
// already baked into each booking block (totalMinutes = duration + buffer).
test("bufferMinutes does NOT add an inter-wave gap (no double-count)", () => {
  const ms = members(7).map((m) => ({ ...m, bufferMinutes: 5 }));
  const res = tryWaveArrangement(T0, ms, staff3, staffById3, null, [], DAY_CLOSE)!;
  const a = res.assignments;
  const wave2Start = T0 + DUR * MIN; // flush — no extra 5-min gap
  const wave3Start = wave2Start + DUR * MIN;
  for (const x of a.filter((y) => y.waveNumber === 2)) assertEqual(x.startMs, wave2Start, "wave2 flush against wave1");
  for (const x of a.filter((y) => y.waveNumber === 3)) assertEqual(x.startMs, wave3Start, "wave3 flush against wave2");
});

test("mixed bufferMinutes still produce flush waves (largest is not added either)", () => {
  const ms = members(7).map((m, i) => ({ ...m, bufferMinutes: i === 0 ? 10 : 5 }));
  const res = tryWaveArrangement(T0, ms, staff3, staffById3, null, [], DAY_CLOSE)!;
  const wave2Start = res.assignments.find((x) => x.waveNumber === 2)!.startMs;
  assertEqual(wave2Start, T0 + DUR * MIN, "wave2 starts flush regardless of per-service buffers");
});

// ── Explicit opts.waveBufferMin still inserts a deliberate inter-wave stagger ──
test("opts.waveBufferMin adds an explicit inter-wave stagger", () => {
  const ms = members(7).map((m) => ({ ...m, bufferMinutes: 5 }));
  const res = tryWaveArrangement(T0, ms, staff3, staffById3, null, [], DAY_CLOSE, { waveBufferMin: 20 })!;
  const wave2Start = res.assignments.find((x) => x.waveNumber === 2)!.startMs;
  assertEqual(wave2Start, T0 + DUR * MIN + 20 * MIN, "explicit stagger applied");
});

// ── Smart Wave Optimizer policy timing ───────────────────────────────
test("maximize_revenue keeps the exact safe 10:10 start for a 7/3 group", () => {
  const staff7: StaffRow[] = Array.from({ length: 7 }, (_, i) => ({
    id: `W${i + 1}`,
    name: `Staff ${i + 1}`,
  }));
  const staffById7 = new Map(staff7.map((staff) => [staff.id, staff]));
  const classicWithBuffer = members(10).map((member) => ({
    ...member,
    totalMinutes: 70,
    bufferMinutes: 10,
  }));
  const nineAm = 9 * 60 * MIN;

  const raw = tryWaveArrangement(
    nineAm,
    classicWithBuffer,
    staff7,
    staffById7,
    null,
    [],
    DAY_CLOSE,
    { strategy: "maximize_revenue" },
  )!;
  const wave2Start = raw.assignments.find((a) => a.waveNumber === 2)!.startMs;

  assertEqual(raw.assignments.filter((a) => a.waveNumber === 1).length, 7);
  assertEqual(raw.assignments.filter((a) => a.waveNumber === 2).length, 3);
  assertEqual(wave2Start, nineAm + 70 * MIN, "wave 2 starts exactly at 10:10");
});

test("balanced rounds later waves to a calm 5-minute cadence", () => {
  const oddDuration = members(7).map((member) => ({
    ...member,
    totalMinutes: 67,
  }));
  const raw = tryWaveArrangement(
    T0,
    oddDuration,
    staff3,
    staffById3,
    null,
    [],
    DAY_CLOSE,
    { strategy: "balanced" },
  )!;
  const wave2Start = raw.assignments.find((a) => a.waveNumber === 2)!.startMs;

  assertEqual(wave2Start, 70 * MIN, "67 minutes rounds to the next 5-minute mark");
});

test("on_time rounds later waves to the customer-facing 15-minute grid", () => {
  const oddDuration = members(7).map((member) => ({
    ...member,
    totalMinutes: 67,
  }));
  const raw = tryWaveArrangement(
    T0,
    oddDuration,
    staff3,
    staffById3,
    null,
    [],
    DAY_CLOSE,
    { strategy: "on_time" },
  )!;
  const wave2Start = raw.assignments.find((a) => a.waveNumber === 2)!.startMs;

  assertEqual(wave2Start, 75 * MIN, "67 minutes rounds to the next quarter-hour");
});

test("optimizer reports capacity recovered without calling it collected revenue", () => {
  const oddDuration = members(7).map((member) => ({
    ...member,
    totalMinutes: 67,
  }));
  const raw = tryWaveArrangement(
    T0,
    oddDuration,
    staff3,
    staffById3,
    null,
    [],
    DAY_CLOSE,
    { strategy: "balanced" },
  )!;
  const arrangement = buildWaveArrangement(raw, oddDuration, staffById3, TZ);
  const optimization = arrangement.waveOptimization!;

  assertEqual(optimization.strategy, "balanced");
  assertEqual(optimization.recoveredClockMinutes, 15);
  // Wave 2 recovers 5 min × 3 people; wave 3 recovers 10 min × 1 person.
  assertEqual(optimization.recoveredCapacityMinutes, 25);
  assertEqual(optimization.addedIdleMinutes, 6);
  assertEqual(optimization.decisions.map((d) => d.memberCount), [3, 1]);
});

// ── Forward-scan: a busy anchor must roll forward to the first fittable time ──
// Regression for the Hi-Lite "group of 12 says no slots today despite a free
// afternoon" bug: tryWaveArrangement dead-ends on a fully-booked anchor, while
// findEarliestWaveArrangement walks forward to where the whole group fits.
test("findEarliestWaveArrangement rolls a busy anchor forward to the first fit", () => {
  // Block all 3 staff for the first 2 hours from T0.
  const blockEnd = T0 + 120 * MIN;
  const existing: ExistingBooking[] = staff3.map((s) => ({
    staffId: s.id,
    startMs: T0,
    endMs: blockEnd,
  }));

  // Bare scheduler dead-ends at the busy anchor.
  assert(
    tryWaveArrangement(T0, members(7), staff3, staffById3, null, existing, DAY_CLOSE) === null,
    "tryWaveArrangement must return null when no staff is free at the anchor",
  );

  // Forward-scan finds the earliest fit (first SLOT_STEP tick at/after blockEnd).
  const res = findEarliestWaveArrangement(T0, members(7), staff3, staffById3, null, existing, DAY_CLOSE);
  assert(res !== null, "forward-scan must find the free window later in the day");
  assertEqual(res!.assignments.length, 7, "all 7 members seated after the scan");
  const firstStart = Math.min(...res!.assignments.map((a) => a.startMs));
  assert(firstStart >= blockEnd, "wave 1 must start at/after the blocked window");
  const stepMs = SLOT_STEP_MIN * MIN;
  assert((firstStart - T0) % stepMs === 0, "anchor lands on a SLOT_STEP tick");
});

// ── Forward-scan no-ops when the requested time is already free ──
test("findEarliestWaveArrangement returns the anchor itself when it's free", () => {
  const res = findEarliestWaveArrangement(T0, members(7), staff3, staffById3, null, [], DAY_CLOSE);
  assert(res !== null, "must seat the group");
  assertEqual(Math.min(...res!.assignments.map((a) => a.startMs)), T0, "starts at the requested anchor");
});

// ── Forward-scan returns null when the group can't fit before close at all ──
test("findEarliestWaveArrangement returns null when nothing fits before close", () => {
  // Close 30 min after open — a 60-min service can never fit.
  const res = findEarliestWaveArrangement(T0, members(7), staff3, staffById3, null, [], T0 + 30 * MIN);
  assert(res === null, "no fit before close → null");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
