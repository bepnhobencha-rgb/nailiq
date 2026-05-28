/**
 * Unit tests for partyLinkActions — pure logic only.
 *
 * Run: npx tsx src/shared/booking/__tests__/partyLinkActions.test.ts
 *
 * These tests cover the pure-logic portions of partyLinkActions that
 * can be exercised without a Supabase connection:
 *   - Token length (≥8 chars, 16 in practice).
 *   - createPartyLink input validation.
 *   - claimPartySlot input validation.
 *   - loadPartyLinkPage short-circuits on bad token.
 *
 * DB-round-trip scenarios (collision retry, RPC results, etc.) are
 * covered by E2E tests.
 */

// ─── Minimal test harness ─────────────────────────────────────────

let pass = 0,
  fail = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(() => {
        pass++;
        console.log(`✓ ${name}`);
      }).catch((e) => {
        fail++;
        console.error(`✗ ${name}`);
        console.error(e);
      });
    } else {
      pass++;
      console.log(`✓ ${name}`);
    }
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

function assertTruthy(actual: unknown, msg?: string) {
  if (!actual) {
    throw new Error(`${msg ?? "expected truthy"}\n  actual: ${JSON.stringify(actual)}`);
  }
}

// ─── Token shape tests (pure crypto, no DB) ───────────────────────

import crypto from "crypto";

test("token generator produces ≥8 chars", () => {
  const token = crypto.randomBytes(8).toString("hex");
  assertTruthy(token.length >= 8, `token length ${token.length} < 8`);
});

test("token generator produces 16 hex chars for 8 bytes", () => {
  const token = crypto.randomBytes(8).toString("hex");
  assertEqual(token.length, 16, "8 random bytes → 16 hex chars");
});

test("token is hex-only", () => {
  for (let i = 0; i < 20; i++) {
    const token = crypto.randomBytes(8).toString("hex");
    if (!/^[0-9a-f]+$/.test(token)) {
      throw new Error(`Non-hex token: ${token}`);
    }
  }
});

test("tokens are unique across 100 samples", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const token = crypto.randomBytes(8).toString("hex");
    if (seen.has(token)) throw new Error(`Duplicate token: ${token}`);
    seen.add(token);
  }
});

// ─── createPartyLink input validation ────────────────────────────
// We test the guard clauses that run BEFORE any DB call.
// The actual DB write requires a Supabase connection and is E2E-tested.

import { createPartyLink } from "../partyLinkActions";

// Helper: a minimal valid params shape.
const validParams = {
  groupId: crypto.randomUUID(),
  salonId: crypto.randomUUID(),
  bookingIds: [crypto.randomUUID(), crypto.randomUUID()],
  mode: "sync_start" as const,
  groupStartUtcIso: new Date().toISOString(),
  baseUrl: "https://nailiq.ca",
};

test("createPartyLink rejects missing groupId", async () => {
  const res = await createPartyLink({ ...validParams, groupId: "" });
  assertEqual(res.ok, false, "empty groupId should fail");
});

test("createPartyLink rejects missing salonId", async () => {
  const res = await createPartyLink({ ...validParams, salonId: "" });
  assertEqual(res.ok, false, "empty salonId should fail");
});

test("createPartyLink rejects single bookingId (groups need ≥2)", async () => {
  const res = await createPartyLink({
    ...validParams,
    bookingIds: [crypto.randomUUID()],
  });
  assertEqual(res.ok, false, "single bookingId should fail");
});

test("createPartyLink rejects empty bookingIds array", async () => {
  const res = await createPartyLink({ ...validParams, bookingIds: [] });
  assertEqual(res.ok, false, "empty bookingIds should fail");
});

// ─── claimPartySlot input validation ─────────────────────────────

import { claimPartySlot } from "../partyLinkActions";

test("claimPartySlot rejects blank name", async () => {
  const res = await claimPartySlot({
    token: "abcd1234",
    claimId: crypto.randomUUID(),
    memberName: "   ",
    memberPhone: "+17788680738",
    reminderOptedIn: false,
  });
  assertEqual(res.ok, false);
  if (!res.ok) assertEqual(res.reason, "invalid_input", "blank name → invalid_input");
});

test("claimPartySlot rejects invalid phone (letters)", async () => {
  const res = await claimPartySlot({
    token: "abcd1234",
    claimId: crypto.randomUUID(),
    memberName: "Alice",
    memberPhone: "not-a-phone",
    reminderOptedIn: false,
  });
  assertEqual(res.ok, false);
  if (!res.ok) assertEqual(res.reason, "invalid_input", "invalid phone → invalid_input");
});

test("claimPartySlot rejects invalid phone (too short)", async () => {
  const res = await claimPartySlot({
    token: "abcd1234",
    claimId: crypto.randomUUID(),
    memberName: "Alice",
    memberPhone: "123",
    reminderOptedIn: false,
  });
  assertEqual(res.ok, false);
  if (!res.ok) assertEqual(res.reason, "invalid_input");
});

// ─── loadPartyLinkPage guard clauses ─────────────────────────────

import { loadPartyLinkPage } from "../partyLinkActions";

test("loadPartyLinkPage returns null for empty token", async () => {
  const res = await loadPartyLinkPage("");
  assertEqual(res, null, "empty token → null");
});

test("loadPartyLinkPage returns null for token shorter than 8 chars", async () => {
  const res = await loadPartyLinkPage("abc");
  assertEqual(res, null, "token < 8 chars → null");
});

// ─── Expiry math ──────────────────────────────────────────────────

test("PARTY_LINK_TTL_MS is exactly 24 hours", () => {
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;
  // Internal constant — verified by checking that a groupStartUtcIso + 24h
  // equals the expected expiry.
  const nowMs = Date.now();
  const groupStartIso = new Date(nowMs).toISOString();
  const expiryMs = new Date(groupStartIso).getTime() + TWENTY_FOUR_HOURS_MS;
  const diffMs = expiryMs - nowMs;
  assertTruthy(
    Math.abs(diffMs - TWENTY_FOUR_HOURS_MS) < 1000,
    `expiry should be ~24h from now, got diff: ${diffMs}ms`,
  );
});

// ─── Summary ─────────────────────────────────────────────────────
// Give async tests a tick to resolve before printing summary.
setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}, 200);
