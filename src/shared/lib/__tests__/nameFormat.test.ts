import {
  isValidCustomerName,
  trimCustomerName,
} from "../nameFormat";

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

test("isValidCustomerName accepts Vietnamese + common separators", () => {
  assertEqual(isValidCustomerName("Nguyễn Thị Mai"), true);
  assertEqual(isValidCustomerName("O'Brien"), true);
  assertEqual(isValidCustomerName("Anna Smith-Jones"), true);
});

test("isValidCustomerName rejects XSS and SQL-ish junk", () => {
  assertEqual(isValidCustomerName("<script>alert('xss')</script>"), false);
  assertEqual(isValidCustomerName("Robert'); DROP TABLE--"), false);
  assertEqual(isValidCustomerName("John & Mary"), false);
});

test("isValidCustomerName rejects empty and too long", () => {
  assertEqual(isValidCustomerName(""), false);
  assertEqual(isValidCustomerName("   "), false);
  assertEqual(isValidCustomerName("a".repeat(101)), false);
});

test("trimCustomerName trims and caps length", () => {
  assertEqual(trimCustomerName("  Ada  "), "Ada");
  assertEqual(trimCustomerName("x".repeat(120)).length, 100);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
