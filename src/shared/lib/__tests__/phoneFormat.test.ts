import { cleanPhone, formatPhone } from "../phoneFormat";

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

test("cleanPhone strips formatting", () => {
  assertEqual(cleanPhone("604-555-0142"), "6045550142");
  assertEqual(cleanPhone("+1 (604) 555-0142"), "+16045550142");
});

test("formatPhone formats 10-digit US", () => {
  assertEqual(formatPhone("6045550142"), "(604) 555-0142");
  assertEqual(formatPhone("16045550142"), "+1 (604) 555-0142");
});

test("formatPhone returns invalid input as-is", () => {
  assertEqual(formatPhone("123"), "123");
  assertEqual(formatPhone(""), "");
  assertEqual(formatPhone(null), "");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
