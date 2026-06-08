import { toCanonicalPhone } from "../toCanonicalPhone";

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

test("strips leading + (the dominant Wix-import format)", () => {
  assertEqual(toCanonicalPhone("+17788680738"), "17788680738");
});

test("adds NANP country code to a bare 10-digit number", () => {
  assertEqual(toCanonicalPhone("7788680738"), "17788680738");
  assertEqual(toCanonicalPhone("(778) 868-0738"), "17788680738");
});

test("keeps an already-canonical number unchanged", () => {
  assertEqual(toCanonicalPhone("17788680738"), "17788680738");
});

test("all three formats collapse to the SAME canonical value", () => {
  const a = toCanonicalPhone("+17788680738");
  const b = toCanonicalPhone("7788680738");
  const c = toCanonicalPhone("1 (778) 868-0738");
  assertEqual(a, b);
  assertEqual(b, c);
});

test("preserves international (Vietnam +84) — does NOT force +1", () => {
  assertEqual(toCanonicalPhone("+84 90 123 4567"), "84901234567");
});

test("returns null for empty / too-short input", () => {
  assertEqual(toCanonicalPhone(""), null);
  assertEqual(toCanonicalPhone(null), null);
  assertEqual(toCanonicalPhone("123"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
