/**
 * Unit tests for serviceBlockMinutes — the shared "duration + buffer" block
 * computation every booking source funnels through.
 *
 * Run: npx tsx src/shared/booking/__tests__/bookingBlock.test.ts
 */

import { serviceBlockMinutes } from "../bookingBlock";

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
  if (actual !== expected) {
    throw new Error(`${msg ?? "assertEqual"}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

test("adds duration and buffer", () => {
  assertEqual(serviceBlockMinutes(60, 5), 65);
  assertEqual(serviceBlockMinutes(30, 0), 30);
  assertEqual(serviceBlockMinutes(45, 15), 60);
});

test("null / undefined buffer counts as 0 (no NaN)", () => {
  assertEqual(serviceBlockMinutes(60, null), 60);
  assertEqual(serviceBlockMinutes(60, undefined), 60);
});

test("null / undefined duration counts as 0", () => {
  assertEqual(serviceBlockMinutes(null, 5), 5);
  assertEqual(serviceBlockMinutes(undefined, undefined), 0);
});

test("non-numeric / garbage coerces to 0, never NaN", () => {
  assertEqual(serviceBlockMinutes("abc", 5), 5);
  assertEqual(serviceBlockMinutes(60, "x"), 60);
  assertEqual(serviceBlockMinutes(NaN, NaN), 0);
});

test("numeric strings (DB sometimes returns text) parse", () => {
  assertEqual(serviceBlockMinutes("60", "5"), 65);
});

test("matches the legacy (Number(x)||0) + (Number(y)||0) inline formula", () => {
  const cases: Array<[unknown, unknown]> = [
    [60, 5],
    [30, null],
    [0, 0],
    [90, undefined],
    ["45", "15"],
    [null, null],
  ];
  for (const [d, b] of cases) {
    const legacy = (Number(d) || 0) + (Number(b) || 0);
    assertEqual(serviceBlockMinutes(d, b), legacy, `d=${JSON.stringify(d)} b=${JSON.stringify(b)}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
