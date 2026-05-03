import {
  formatInSalonTz,
  salonDateOffset,
  salonDayRangeUtc,
  salonNowMinutes,
  salonToday,
} from "../salonTime";

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

const PACIFIC = "America/Los_Angeles";
const EASTERN = "America/New_York";

test("formatInSalonTz — UTC to Pacific PDT (2026-05-02)", () => {
  const utc = "2026-05-02T22:30:00.000Z";
  assertEqual(formatInSalonTz(utc, PACIFIC, "time"), "3:30 PM");
  assertEqual(formatInSalonTz(utc, PACIFIC, "shortTime"), "3:30p");
  assertEqual(formatInSalonTz(utc, PACIFIC, "date"), "Sat, May 2");
  assertEqual(formatInSalonTz(utc, PACIFIC, "datetime"), "Sat, May 2 · 3:30 PM");
});

test("salonToday — fixed nowIso yields correct YYYY-MM-DD in LA", () => {
  const nowIso = "2026-05-02T08:00:00.000Z";
  assertEqual(salonToday(PACIFIC, nowIso), "2026-05-02");
});

test("salonDateOffset — yesterday / tomorrow from fixed now", () => {
  const nowIso = "2026-05-02T08:00:00.000Z";
  assertEqual(salonDateOffset(PACIFIC, -1, nowIso), "2026-05-01");
  assertEqual(salonDateOffset(PACIFIC, 1, nowIso), "2026-05-03");
});

test("salonDayRangeUtc — Pacific PDT May 2 → 07:00Z bounds", () => {
  const r = salonDayRangeUtc("2026-05-02", PACIFIC);
  assertEqual(r.startUtc.startsWith("2026-05-02T07:00:00.000Z"), true);
  assertEqual(r.endUtc.startsWith("2026-05-03T07:00:00.000Z"), true);
});

test("salonDayRangeUtc — Eastern EDT May 2 → 04:00Z bounds", () => {
  const r = salonDayRangeUtc("2026-05-02", EASTERN);
  assertEqual(r.startUtc.startsWith("2026-05-02T04:00:00.000Z"), true);
  assertEqual(r.endUtc.startsWith("2026-05-03T04:00:00.000Z"), true);
});

test("salonNowMinutes — 3:30 PM Pacific from fixed nowIso", () => {
  const nowIso = "2026-05-02T22:30:00.000Z";
  assertEqual(salonNowMinutes(PACIFIC, nowIso), 930);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
