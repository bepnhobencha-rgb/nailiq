/**
 * Unit tests for displayCustomerName (display-only name formatting).
 *
 * Run: npx tsx src/shared/lib/__tests__/customerDisplayName.test.ts
 */
import { displayCustomerName } from "../customerDisplayName";

const REMOVED = "Removed guest";
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
function eq(actual: unknown, expected: unknown, msg?: string) {
  if (actual !== expected) {
    throw new Error(`${msg ?? "eq"}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// ── Redaction sentinel ──────────────────────────────────────────
test("maps [removed] to the localized label", () => {
  eq(displayCustomerName("[removed]", REMOVED), REMOVED);
});
test("sentinel match is case-insensitive + trims", () => {
  eq(displayCustomerName("  [REMOVED] ", REMOVED), REMOVED);
  eq(displayCustomerName("[deleted]", REMOVED), REMOVED);
});

// ── Empty → "" (caller keeps its own — fallback) ────────────────
test("empty / whitespace returns empty string", () => {
  eq(displayCustomerName("", REMOVED), "");
  eq(displayCustomerName("   ", REMOVED), "");
  eq(displayCustomerName(null, REMOVED), "");
  eq(displayCustomerName(undefined, REMOVED), "");
});

// ── ALL-CAPS softening ──────────────────────────────────────────
test("softens a single all-caps token to title case", () => {
  eq(displayCustomerName("HUY", REMOVED), "Huy");
});
test("softens multi-word all-caps, preserving spacing", () => {
  eq(displayCustomerName("NGUYEN VAN A", REMOVED), "Nguyen Van A");
  eq(displayCustomerName("MAI  LINH", REMOVED), "Mai  Linh"); // double space kept
});
test("preserves Vietnamese diacritics when softening", () => {
  eq(displayCustomerName("HUỲNH", REMOVED), "Huỳnh");
  eq(displayCustomerName("TRẦN THỊ", REMOVED), "Trần Thị");
});

// ── Leaves intentional casing untouched ─────────────────────────
test("already mixed-case names are unchanged", () => {
  eq(displayCustomerName("Huy", REMOVED), "Huy");
  eq(displayCustomerName("McDonald", REMOVED), "McDonald");
  eq(displayCustomerName("Trần Thị", REMOVED), "Trần Thị");
});
test("lowercase names are unchanged (not all-caps)", () => {
  eq(displayCustomerName("huy", REMOVED), "huy");
});
test("non-letter strings are unchanged", () => {
  eq(displayCustomerName("123", REMOVED), "123");
});
test("KNOWN LIMITATION: short acronyms are title-cased too (all-caps rule)", () => {
  // We cannot distinguish a caps-lock name ("HUY") from an acronym ("MD"),
  // so any fully-uppercase token is softened. This is display-only; the DB
  // value is never changed. Documented, accepted tradeoff.
  eq(displayCustomerName("MD", REMOVED), "Md");
});
test("trims surrounding whitespace on normal names", () => {
  eq(displayCustomerName("  Huy  ", REMOVED), "Huy");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
