/**
 * Unit tests for Party Card Dashboard — pure logic only.
 *
 * Run: npx tsx src/shared/dashboard/__tests__/loadPartyCards.test.ts
 *
 * These tests cover the pure-logic portions that can be exercised without
 * a Supabase connection:
 *   - buildPartyCard: confirmed/pending counts, revenue, phone absence.
 *   - partyCardWindowUtc: date window math.
 *   - Multi-tenant boundary (tested structurally via field absence).
 *   - Revenue: only shown when ALL slots have price_cents.
 */

import crypto from "crypto";
import {
  buildPartyCard,
  partyCardWindowUtc,
  type RawClaim,
  type RawPartyLink,
} from "../partyCardHelpers";

// ─── Minimal test harness ─────────────────────────────────────────

let pass = 0,
  fail = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const r = (() => {
    try {
      return fn();
    } catch (e) {
      fail++;
      console.error(`✗ ${name}`);
      console.error(e);
      return undefined;
    }
  })();

  if (r instanceof Promise) {
    r.then(() => {
      pass++;
      console.log(`✓ ${name}`);
    }).catch((e) => {
      fail++;
      console.error(`✗ ${name}`);
      console.error(e);
    });
  } else if (r !== undefined || fail === fail) {
    // synchronous test passed (no throw)
    pass++;
    console.log(`✓ ${name}`);
  }
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg ?? "assertion failed"}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

function assertNull(actual: unknown, msg?: string) {
  if (actual !== null) {
    throw new Error(`${msg ?? "expected null"}\n  actual: ${JSON.stringify(actual)}`);
  }
}

function assertNotNull(actual: unknown, msg?: string) {
  if (actual === null || actual === undefined) {
    throw new Error(`${msg ?? "expected non-null"}\n  actual: ${JSON.stringify(actual)}`);
  }
}

function assertTrue(actual: unknown, msg?: string) {
  if (!actual) {
    throw new Error(`${msg ?? "expected truthy"}\n  actual: ${JSON.stringify(actual)}`);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────

const NOW = new Date("2026-06-01T14:00:00Z");
const TZ = "America/Vancouver";
const SALON_ID = crypto.randomUUID();
const GROUP_ID = crypto.randomUUID();
const PARTY_LINK_ID = crypto.randomUUID();

function makeLink(overrides: Partial<RawPartyLink> = {}): RawPartyLink {
  return {
    id: PARTY_LINK_ID,
    group_id: GROUP_ID,
    token: crypto.randomBytes(8).toString("hex"),
    mode: "sync_start",
    expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeClaim(overrides: {
  member_name?: string | null;
  claimed_at?: string | null;
  price_cents?: number | null;
  client_name?: string | null;
  start?: string;
  end?: string;
  service?: string;
  staff?: string;
} = {}): RawClaim {
  const start = overrides.start ?? "2026-06-01T17:00:00Z";
  const end = overrides.end ?? "2026-06-01T17:40:00Z";
  return {
    id: crypto.randomUUID(),
    party_link_id: PARTY_LINK_ID,
    booking_id: crypto.randomUUID(),
    member_name: overrides.member_name ?? null,
    claimed_at: overrides.claimed_at ?? null,
    bookings: {
      start_time_utc: start,
      end_time_utc: end,
      price_cents: overrides.price_cents !== undefined ? overrides.price_cents : 2500,
      client_name: overrides.client_name ?? "Guest 1",
      services: { name: overrides.service ?? "Classic Manicure" },
      staff: { name: overrides.staff ?? "Liam" },
    },
  };
}

// ─── partyCardWindowUtc ───────────────────────────────────────────

test("window start is midnight UTC today", () => {
  const { start } = partyCardWindowUtc();
  assertEqual(start.getUTCHours(), 0, "start.hours");
  assertEqual(start.getUTCMinutes(), 0, "start.minutes");
  assertEqual(start.getUTCSeconds(), 0, "start.seconds");
});

test("window end is 8 days from start (covers all of day 7)", () => {
  const { start, end } = partyCardWindowUtc();
  const diffMs = end.getTime() - start.getTime();
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  assertEqual(diffDays, 8, "window should span 8 days");
});

// ─── buildPartyCard — slot counting ──────────────────────────────

test("claimedCount and pendingCount are correct", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ member_name: "Alice", claimed_at: NOW.toISOString() }),
    makeClaim({ member_name: "Bob", claimed_at: NOW.toISOString() }),
    makeClaim({ member_name: null, claimed_at: null }),
    makeClaim({ member_name: null, claimed_at: null }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertEqual(card.claimedCount, 2, "2 claimed");
  assertEqual(card.pendingCount, 2, "2 pending");
  assertEqual(card.totalSlots, 4, "4 total");
});

test("all claimed → pendingCount is 0", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ claimed_at: NOW.toISOString() }),
    makeClaim({ claimed_at: NOW.toISOString() }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertEqual(card.pendingCount, 0);
  assertEqual(card.claimedCount, 2);
});

test("none claimed → claimedCount is 0", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ claimed_at: null }),
    makeClaim({ claimed_at: null }),
    makeClaim({ claimed_at: null }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertEqual(card.claimedCount, 0);
  assertEqual(card.pendingCount, 3);
});

// ─── buildPartyCard — revenue ─────────────────────────────────────

test("estimatedRevenueCents sums all prices when all are present", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ price_cents: 2500 }),
    makeClaim({ price_cents: 3000 }),
    makeClaim({ price_cents: 1500 }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertEqual(card.estimatedRevenueCents, 7000, "2500+3000+1500=7000 cents");
});

test("estimatedRevenueCents is null when ANY price is missing", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ price_cents: 2500 }),
    makeClaim({ price_cents: null }), // missing
    makeClaim({ price_cents: 3000 }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertNull(card.estimatedRevenueCents, "revenue must be null when any price missing");
});

test("estimatedRevenueCents is null when all prices are missing", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ price_cents: null }),
    makeClaim({ price_cents: null }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertNull(card.estimatedRevenueCents, "revenue null when all prices missing");
});

test("estimatedRevenueCents is null for empty slot list", () => {
  const link = makeLink();
  const card = buildPartyCard(link, [], TZ, NOW);
  assertNull(card.estimatedRevenueCents, "no slots → no revenue");
});

// ─── Phone privacy: PartyCard type has no phone field ────────────

test("PartyCard slots do NOT contain member_phone", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ member_name: "Alice", claimed_at: NOW.toISOString() }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  const slot = card.slots[0];
  assertTrue(!("memberPhone" in slot), "slot must not have memberPhone");
  assertTrue(!("member_phone" in slot), "slot must not have member_phone");
  assertTrue(!("phone" in slot), "slot must not have phone");
  // The type itself doesn't include phone, but we verify the runtime object too.
  const cardJson = JSON.stringify(card);
  assertTrue(!cardJson.includes("Phone"), "card JSON must not contain 'Phone'");
  assertTrue(!cardJson.includes("phone"), "card JSON must not contain 'phone'");
});

// ─── buildPartyCard — expired flag ───────────────────────────────

test("expired is true when expires_at is in the past", () => {
  const link = makeLink({
    expires_at: new Date(NOW.getTime() - 1000).toISOString(), // 1 second ago
  });
  const claims = [makeClaim()];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertTrue(card.expired, "should be expired");
});

test("expired is false when expires_at is in the future", () => {
  const link = makeLink({
    expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(), // +1h
  });
  const claims = [makeClaim()];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertTrue(!card.expired, "should NOT be expired");
});

// ─── buildPartyCard — member names / placeholders ────────────────

test("unclaimed slots have null memberName (UI shows Guest N)", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ member_name: null, claimed_at: null }),
    makeClaim({ member_name: "Hana", claimed_at: NOW.toISOString() }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  // Unclaimed slot (first by start time) → memberName null
  const unclaimed = card.slots.find((s) => !s.claimed);
  assertNull(unclaimed?.memberName ?? null, "unclaimed slot memberName must be null");
  // Claimed slot → memberName set
  const claimed = card.slots.find((s) => s.claimed);
  assertEqual(claimed?.memberName, "Hana", "claimed slot has name");
});

// ─── buildPartyCard — mode preservation ──────────────────────────

test("sync_start mode is preserved", () => {
  const link = makeLink({ mode: "sync_start" });
  const card = buildPartyCard(link, [makeClaim()], TZ, NOW);
  assertEqual(card.mode, "sync_start");
});

test("sync_finish mode is preserved", () => {
  const link = makeLink({ mode: "sync_finish" });
  const card = buildPartyCard(link, [makeClaim()], TZ, NOW);
  assertEqual(card.mode, "sync_finish");
});

// ─── buildPartyCard — sort order ─────────────────────────────────

test("slots are sorted by start_time_utc ascending", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ start: "2026-06-01T19:00:00Z", service: "Gel" }),
    makeClaim({ start: "2026-06-01T17:00:00Z", service: "Manicure" }),
    makeClaim({ start: "2026-06-01T18:00:00Z", service: "Pedicure" }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  const services = card.slots.map((s) => s.serviceName);
  assertEqual(services, ["Manicure", "Pedicure", "Gel"], "slots sorted by start");
});

// ─── Multi-tenant boundary (structural) ──────────────────────────

test("PartyCard includes groupId and partyLinkId for auditing", () => {
  const link = makeLink({ group_id: GROUP_ID, id: PARTY_LINK_ID });
  const card = buildPartyCard(link, [makeClaim()], TZ, NOW);
  assertEqual(card.groupId, GROUP_ID, "groupId matches");
  assertEqual(card.partyLinkId, PARTY_LINK_ID, "partyLinkId matches");
});

test("PartyCard token matches the party link token", () => {
  const token = crypto.randomBytes(8).toString("hex");
  const link = makeLink({ token });
  const card = buildPartyCard(link, [makeClaim()], TZ, NOW);
  assertEqual(card.token, token, "token matches");
});

// ─── groupStartDisplay is never "—" when claims have start times ─────
// Regression test for the groupStartIso reduce bug (initial value ""
// always won the min comparison, making groupStartDisplay always "—").

test("groupStartDisplay shows earliest slot start, not '—'", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ start: "2026-06-01T17:00:00Z" }),
    makeClaim({ start: "2026-06-01T17:40:00Z" }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertTrue(
    card.groupStartDisplay !== "—",
    `groupStartDisplay should not be '—', got: '${card.groupStartDisplay}'`,
  );
});

test("groupStartDisplay reflects the earliest slot across all claims", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ start: "2026-06-01T18:00:00Z" }),
    makeClaim({ start: "2026-06-01T17:00:00Z" }),
    makeClaim({ start: "2026-06-01T19:00:00Z" }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  // 17:00 UTC = 10:00 AM Vancouver (PDT, UTC-7)
  const cardEarliest = buildPartyCard(
    link,
    [makeClaim({ start: "2026-06-01T17:00:00Z" })],
    TZ,
    NOW,
  );
  assertEqual(
    card.groupStartDisplay,
    cardEarliest.groupStartDisplay,
    "groupStartDisplay must equal display of the earliest start",
  );
});

test("groupEndDisplay shows latest slot end", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ start: "2026-06-01T17:00:00Z", end: "2026-06-01T17:40:00Z" }),
    makeClaim({ start: "2026-06-01T18:00:00Z", end: "2026-06-01T19:00:00Z" }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertTrue(
    card.groupEndDisplay !== "—",
    `groupEndDisplay should not be '—', got: '${card.groupEndDisplay}'`,
  );
  const cardLatest = buildPartyCard(
    link,
    [makeClaim({ start: "2026-06-01T18:00:00Z", end: "2026-06-01T19:00:00Z" })],
    TZ,
    NOW,
  );
  assertEqual(
    card.groupEndDisplay,
    cardLatest.groupEndDisplay,
    "groupEndDisplay must equal display of the latest end",
  );
});

test("buildPartyCard with no claims returns empty groupStartDisplay", () => {
  const link = makeLink();
  const card = buildPartyCard(link, [], TZ, NOW);
  assertEqual(card.groupStartDisplay, "—", "empty claims → groupStartDisplay is '—'");
  assertEqual(card.groupEndDisplay, "—", "empty claims → groupEndDisplay is '—'");
});

// ─── Party Card appears when party_links row exists ───────────────
// Structural test: loadPartyCardsAction only shows groups that have
// a party_links row. This test verifies that buildPartyCard produces
// a card (not null/undefined) when given a valid party link + claims.

test("buildPartyCard returns a valid card when party link and claims exist", () => {
  const link = makeLink();
  const claims = [
    makeClaim({ start: "2026-06-01T17:00:00Z", member_name: "Alice", claimed_at: new Date().toISOString() }),
    makeClaim({ start: "2026-06-01T17:40:00Z", member_name: null, claimed_at: null }),
  ];
  const card = buildPartyCard(link, claims, TZ, NOW);
  assertNotNull(card, "card must not be null");
  assertEqual(card.totalSlots, 2);
  assertEqual(card.claimedCount, 1);
  assertEqual(card.pendingCount, 1);
  assertTrue(card.partyLinkId === PARTY_LINK_ID, "partyLinkId must match");
});

// ─── Summary ─────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}, 200);
