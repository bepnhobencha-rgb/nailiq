/**
 * Unit tests for validateGuestPhone.
 *
 * Run: npx tsx src/shared/booking/__tests__/validateGuestPhone.test.ts
 *
 * ── tsx / Node v24 compatibility note ────────────────────────────────────────
 * The original import in validateGuestPhone.ts used `"libphonenumber-js"` (the
 * default entry), which internally calls CJS `require('../metadata.min.json')`.
 * tsx wraps .json CJS-requires in `{ default: … }`, so the metadata object
 * arrived as `{ default: { version:4, … } }` instead of the raw object —
 * `metadata.countries` was undefined, and every call threw:
 *   "Cannot read properties of undefined (reading 'hasOwnProperty')"
 *
 * Fix (already applied to validateGuestPhone.ts): switched to
 * `libphonenumber-js/core` + an explicit ES-module `import` for the metadata
 * JSON.  ES-module imports correctly unwrap the `.default` export in all
 * environments (tsx, Next.js bundler, native Node.js ESM).
 *
 * ── test-number validity note ─────────────────────────────────────────────────
 * libphonenumber-js validates structural correctness (real area codes, right
 * digit counts for the region).  Fake / placeholder numbers (555-xxxx, bare
 * "6041234567", etc.) return isValid()=false and therefore ok:false.  All test
 * numbers below are structurally valid numbers in their respective regions;
 * none are guaranteed to be active subscriber lines.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { validateGuestPhone } from "../validateGuestPhone";

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

// 778 is a valid Vancouver/BC area code; 868-0738 is a structurally valid
// subscriber number in the NANP.
test("CA local 10-digit → +1 normalized", () => {
  assertEqual(validateGuestPhone("7788680738"), {
    ok: true,
    digits: "17788680738",
  });
});

test("CA E.164", () => {
  assertEqual(validateGuestPhone("+1 778 868 0738"), {
    ok: true,
    digits: "17788680738",
  });
});

test("VN E.164 still accepted", () => {
  assertEqual(validateGuestPhone("+84 90 123 4567"), {
    ok: true,
    digits: "84901234567",
  });
});

// 212 (New York City) + a structurally valid 7-digit local number.
test("US E.164 (NANP) accepted", () => {
  assertEqual(validateGuestPhone("+1 212 664 7665"), {
    ok: true,
    digits: "12126647665",
  });
});

test("rejects junk and short numbers", () => {
  assertEqual(validateGuestPhone("abc"), { ok: false });
  assertEqual(validateGuestPhone(""), { ok: false });
  assertEqual(validateGuestPhone("123"), { ok: false });
  assertEqual(validateGuestPhone("+++"), { ok: false });
});

test("rejects impossible NANP (1-prefix area code starts with 1)", () => {
  assertEqual(validateGuestPhone("1234567890"), { ok: false });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
