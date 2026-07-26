/**
 * Unit tests for resolveCustomerLocale (staff-action notification locale).
 *
 * Run: npx tsx src/shared/notifications/__tests__/resolveCustomerLocale.test.ts
 */

import {
  resolveCustomerLocale,
  DEFAULT_CUSTOMER_LOCALE,
} from "../resolveCustomerLocale";

let pass = 0,
  fail = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Global default is English.
eq(DEFAULT_CUSTOMER_LOCALE, "en");

// 1. Online booker's site language always wins.
test("online client_locale=vi wins over salon en default", () => {
  eq(
    resolveCustomerLocale({ clientLocale: "vi", salonDefaultLocale: "en" }),
    "vi",
  );
});
test("online client_locale=en honored", () => {
  eq(resolveCustomerLocale({ clientLocale: "en", salonDefaultLocale: "vi" }), "en");
});

// 2. Staff/desk booking (no client_locale) → salon default.
test("desk booking falls to salon default vi", () => {
  eq(resolveCustomerLocale({ salonDefaultLocale: "vi" }), "vi");
});
test("desk booking with no salon default → English", () => {
  eq(resolveCustomerLocale({}), "en");
});

// 3. preferred_language sits between client_locale and salon default.
test("preferred_language used when no client_locale", () => {
  eq(
    resolveCustomerLocale({ preferredLanguage: "vi", salonDefaultLocale: "en" }),
    "vi",
  );
});
test("client_locale beats preferred_language", () => {
  eq(
    resolveCustomerLocale({ clientLocale: "en", preferredLanguage: "vi" }),
    "en",
  );
});

// 4. Normalization + junk handling.
test("region tags normalized (en-US → en)", () => {
  eq(resolveCustomerLocale({ clientLocale: "en-US" }), "en");
});
test("uppercase/whitespace normalized", () => {
  eq(resolveCustomerLocale({ clientLocale: "  VI  " }), "vi");
});
test("unsupported locale ignored, falls through to default", () => {
  eq(resolveCustomerLocale({ clientLocale: "fr", salonDefaultLocale: "zz" }), "en");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
