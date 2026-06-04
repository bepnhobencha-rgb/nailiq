/**
 * Branded canvas — unit tests for the luminance-adaptive booking palette.
 *
 * Run: npx tsx src/shared/booking/__tests__/bookingThemeVars.test.ts
 *
 * Invariants under test:
 *   1. Light mode keeps text + CTA fixed (contrast budget untouched).
 *   2. Dark mode keeps text + CTA fixed.
 *   3. Surfaces are derived from the brand colour via color-mix.
 *   4. Exactly the 4 surface vars carry the brand (text/cta never tinted).
 *   5. Luminance-adaptive: a bright brand tints a light canvas more than a
 *      dark brand, and both stay within the safe 3–7% band.
 */

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
    throw new Error(`${msg ?? ""}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function assertTruthy(v: unknown, msg?: string) {
  if (!v) throw new Error(msg ?? `Expected truthy, got: ${JSON.stringify(v)}`);
}

import { buildBookingThemeVars } from "../bookingThemeVars";

const pctOf = (s: string): number => Number(/(\d+)%/.exec(s)?.[1] ?? "0");

test("1. Light mode keeps text + CTA fixed", () => {
  const v = buildBookingThemeVars("#D4AF37", "light");
  assertEqual(v["--booking-text"], "#1a1a1a", "text");
  assertEqual(v["--cta-bg"], "#1a1a1a", "cta-bg");
  assertEqual(v["--cta-text"], "#ffffff", "cta-text");
});

test("2. Dark mode keeps text + CTA fixed", () => {
  const v = buildBookingThemeVars("#D4AF37", "dark");
  assertEqual(v["--booking-text"], "#ffffff", "text");
  assertEqual(v["--cta-bg"], "#ffffff", "cta-bg");
  assertEqual(v["--cta-text"], "#0a0a0a", "cta-text");
});

test("3. Surfaces derived from brand via color-mix", () => {
  const v = buildBookingThemeVars("#E91E8C", "light");
  assertTruthy(v["--booking-bg"].includes("color-mix"), "bg uses color-mix");
  assertTruthy(v["--booking-bg"].includes("#E91E8C"), "bg carries brand");
  assertTruthy(v["--booking-border"].includes("#E91E8C"), "border carries brand");
});

test("4. Exactly 4 surface vars carry the brand", () => {
  const v = buildBookingThemeVars("#00BCD4", "dark");
  const brandCarrying = Object.values(v).filter((val) => val.includes("#00BCD4"));
  assertEqual(brandCarrying.length, 4, "bg + card + input + border only");
});

test("5. Luminance-adaptive + within 3–7% band (light canvas)", () => {
  const bright = pctOf(buildBookingThemeVars("#FFF1B8", "light")["--booking-bg"]);
  const dark = pctOf(buildBookingThemeVars("#101010", "light")["--booking-bg"]);
  assertTruthy(bright > dark, `bright(${bright}) > dark(${dark})`);
  assertTruthy(bright <= 7, `bright(${bright}) <= 7`);
  assertTruthy(dark >= 3, `dark(${dark}) >= 3`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
