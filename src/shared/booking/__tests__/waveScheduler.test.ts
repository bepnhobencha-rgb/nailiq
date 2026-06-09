/**
 * Unit tests for the Phase 6 wave scheduler (tryWaveArrangement +
 * buildWaveArrangement) — pure functions only.
 *
 * Covers:
 *   - over-capacity group splits into the right number of waves
 *   - wave N+1 starts at wave N's latest end + WAVE_BUFFER_MIN
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
  WAVE_BUFFER_MIN,
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

// ── wave N+1 starts at wave N latest end + buffer ──
test("each wave starts at previous wave end + WAVE_BUFFER_MIN", () => {
  const res = tryWaveArrangement(T0, members(7), staff3, staffById3, null, [], DAY_CLOSE)!;
  const a = res.assignments;
  const wave1Start = T0;
  const wave1End = T0 + DUR * MIN;
  const wave2Start = wave1End + WAVE_BUFFER_MIN * MIN;
  const wave2End = wave2Start + DUR * MIN;
  const wave3Start = wave2End + WAVE_BUFFER_MIN * MIN;

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

// ── Inter-wave gap derives from the per-service buffer ──
test("wave gap = members' bufferMinutes when set (not the 15-min fallback)", () => {
  const BUF = 5;
  const ms = members(7).map((m) => ({ ...m, bufferMinutes: BUF }));
  const res = tryWaveArrangement(T0, ms, staff3, staffById3, null, [], DAY_CLOSE)!;
  const a = res.assignments;
  const wave1End = T0 + DUR * MIN;
  const wave2Start = wave1End + BUF * MIN; // 5-min gap, not 15
  const wave2End = wave2Start + DUR * MIN;
  const wave3Start = wave2End + BUF * MIN;
  for (const x of a.filter((y) => y.waveNumber === 2)) assertEqual(x.startMs, wave2Start, "wave2 start uses 5-min buffer");
  for (const x of a.filter((y) => y.waveNumber === 3)) assertEqual(x.startMs, wave3Start, "wave3 start uses 5-min buffer");
});

// ── Mixed buffers → the largest in the wave wins (every chair gets enough reset) ──
test("wave gap uses the max bufferMinutes among seated members", () => {
  const ms = members(7).map((m, i) => ({ ...m, bufferMinutes: i === 0 ? 10 : 5 }));
  const res = tryWaveArrangement(T0, ms, staff3, staffById3, null, [], DAY_CLOSE)!;
  const wave2Start = res.assignments.find((x) => x.waveNumber === 2)!.startMs;
  assertEqual(wave2Start, T0 + DUR * MIN + 10 * MIN, "wave2 start uses the max (10) buffer");
});

// ── Explicit opts.waveBufferMin still overrides the derived value ──
test("opts.waveBufferMin overrides per-service buffer", () => {
  const ms = members(7).map((m) => ({ ...m, bufferMinutes: 5 }));
  const res = tryWaveArrangement(T0, ms, staff3, staffById3, null, [], DAY_CLOSE, { waveBufferMin: 20 })!;
  const wave2Start = res.assignments.find((x) => x.waveNumber === 2)!.startMs;
  assertEqual(wave2Start, T0 + DUR * MIN + 20 * MIN, "explicit override wins");
});

// ── Zero buffer falls back to WAVE_BUFFER_MIN (avoids stacked chairs on misconfig) ──
test("zero bufferMinutes falls back to WAVE_BUFFER_MIN", () => {
  const ms = members(7).map((m) => ({ ...m, bufferMinutes: 0 }));
  const res = tryWaveArrangement(T0, ms, staff3, staffById3, null, [], DAY_CLOSE)!;
  const wave2Start = res.assignments.find((x) => x.waveNumber === 2)!.startMs;
  assertEqual(wave2Start, T0 + DUR * MIN + WAVE_BUFFER_MIN * MIN, "0 buffer → 15-min fallback");
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
