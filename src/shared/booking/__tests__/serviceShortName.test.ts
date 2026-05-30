/**
 * Unit tests for serviceShortName + bookingSourceIcon (P1 readability polish).
 *
 * Run: npx tsx src/shared/booking/__tests__/serviceShortName.test.ts
 */

import { serviceShortName } from "../serviceShortName";
import { bookingSourceIcon } from "../bookingSourceIcon";

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
    throw new Error(`${msg ?? "assertEqual"}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}
function assertTrue(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg ?? "expected true");
}

// ── serviceShortName ────────────────────────────────────────────

test("built-in abbreviations apply (case-insensitive)", () => {
  assertEqual(serviceShortName("Acrylic Fill"), "Acr Fill");
  assertEqual(serviceShortName("gel manicure"), "Gel Mani");
  assertEqual(serviceShortName("Pedicure Classic"), "Pedi Classic");
  assertEqual(serviceShortName("Classic Manicure"), "Classic Mani");
  assertEqual(serviceShortName("Gel Remove + Redo"), "Gel Redo");
});

test("unknown service name falls back to full name", () => {
  assertEqual(serviceShortName("Bespoke Luxury Treatment"), "Bespoke Luxury Treatment");
});

test("empty / whitespace returns trimmed input", () => {
  assertEqual(serviceShortName(""), "");
  assertEqual(serviceShortName("   "), "");
});

test("overrides win over built-in defaults", () => {
  assertEqual(
    serviceShortName("Gel Manicure", { "gel manicure": "GM" }),
    "GM",
  );
});

test("overrides match by exact (non-lowercased) key too", () => {
  assertEqual(
    serviceShortName("Custom Service", { "Custom Service": "Cust" }),
    "Cust",
  );
});

// ── bookingSourceIcon ───────────────────────────────────────────

test("known sources resolve to icon + label", () => {
  const voice = bookingSourceIcon("voice");
  assertTrue(voice !== null && voice.label === "Voice AI", "voice → Voice AI");
  const walkin = bookingSourceIcon("walkin");
  assertTrue(walkin !== null && walkin.label === "Walk-in", "walkin → Walk-in");
  const online = bookingSourceIcon("online");
  assertTrue(online !== null && online.label === "Online", "online → Online");
  const appt = bookingSourceIcon("appointment");
  assertTrue(appt !== null && appt.label === "Appointment", "appointment → Appointment");
});

test("source matching is case-insensitive + trims", () => {
  assertTrue(bookingSourceIcon("  VOICE ") !== null, "trims + lowercases");
});

test("unknown / empty source returns null (hidden safely)", () => {
  assertEqual(bookingSourceIcon("quantum"), null);
  assertEqual(bookingSourceIcon(null), null);
  assertEqual(bookingSourceIcon(undefined), null);
  assertEqual(bookingSourceIcon(""), null);
});

test("localized label override is honored", () => {
  const m = bookingSourceIcon("walkin", { walkin: "Khách ghé qua" });
  assertTrue(m !== null && m.label === "Khách ghé qua", "VI label applied");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
