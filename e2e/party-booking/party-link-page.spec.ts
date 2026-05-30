/**
 * Party Booking — /party/[token] page E2E tests.
 *
 * Covers:
 *   - Test 4: Party Link public page opens and shows slots
 *   - Test 5: Claim one slot
 *   - Test 6: Edit my details after claiming
 *   - Test 7: Submit a change request after claiming
 *
 * Uses directly-seeded party links to avoid re-running the full web flow.
 *
 * Run: npm run test:e2e -- e2e/party-booking/party-link-page.spec.ts
 */
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  cleanupPartyTestSalon,
  getChangeRequests,
  getPartyClaims,
  gotoPartyLinkPage,
  seedPartyLink,
  seedPartyTestSalon,
  type PartyTestSalon,
  type SeededPartyLink,
} from "./helpers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SLUG = "e2e-party-claim";
let salon: PartyTestSalon;

test.beforeAll(async () => {
  salon = await seedPartyTestSalon(SLUG);
});

test.afterAll(async () => {
  await cleanupPartyTestSalon(SLUG, salon?.salonId);
});

// ─── Fresh party link per test for isolation ─────────────────────
// Use increasing hoursFromNow offsets so parallel-executed tests don't
// create overlapping bookings for the same staff at the same time.

let link: SeededPartyLink;
let testIndex = 3; // Start far enough from "now" to avoid real bookings
test.beforeEach(async () => {
  testIndex += 1;
  link = await seedPartyLink({
    salonId: salon.salonId,
    staffIds: salon.staffIds,
    serviceIds: salon.serviceIds,
    slotCount: 2,
    hoursFromNow: testIndex,
  });
});

test.afterEach(async () => {
  // Clean up this test's party link + bookings to prevent bookings_no_overlap
  // conflicts on the next test's insert.
  if (link?.partyLinkId) {
    await supabase.from("party_link_change_requests").delete().eq("party_link_id", link.partyLinkId);
    await supabase.from("party_link_claims").delete().eq("party_link_id", link.partyLinkId);
    await supabase.from("party_links").delete().eq("id", link.partyLinkId);
  }
  if (link?.bookingIds?.length) {
    await supabase.from("bookings").delete().in("id", link.bookingIds);
  }
});

// ─── Test 4: Party Link page opens ───────────────────────────────

test("Party Link page renders slot cards", async ({ page }) => {
  await gotoPartyLinkPage(page, link.token);

  // Both slot cards visible
  const cards = page.locator('[data-testid^="party-slot-card-"]');
  await expect(cards).toHaveCount(2, { timeout: 10_000 });

  // At least one "This is me" button
  await expect(page.getByTestId("party-claim-btn").first()).toBeVisible();
});

// ─── Test 5: Claim one slot ───────────────────────────────────────

test("claiming a slot updates the UI and DB", async ({ page }) => {
  await gotoPartyLinkPage(page, link.token);

  // Scope to the first slot card.
  const firstCard = page.locator('[data-testid^="party-slot-card-"]').first();

  // Expand first claim form — use evaluate() so the click bubbles through
  // React's event delegation (same pattern as pickDateInCalendar).
  await firstCard
    .getByTestId("party-claim-btn")
    .evaluate((el) => (el as HTMLButtonElement).click());

  // Fill in claim details
  await firstCard.getByTestId("party-claim-name").fill("E2E Alice");
  await firstCard.getByTestId("party-claim-phone").fill("+16045550001");
  await firstCard.getByTestId("party-claim-submit").click();

  // Claim button gone on this card; member name appears immediately.
  await expect(firstCard.getByTestId("party-claim-btn")).not.toBeVisible({ timeout: 10_000 });
  await expect(firstCard.getByText("E2E Alice")).toBeVisible({ timeout: 10_000 });

  // DB: claim row should have member_name set
  await expect
    .poll(
      async () => {
        const claims = await getPartyClaims(link.partyLinkId);
        return claims.some((c) => c.member_name === "E2E Alice" && c.claimed_at !== null);
      },
      { timeout: 10_000, intervals: [500] },
    )
    .toBe(true);
});

// ─── Test 6: Edit my details ──────────────────────────────────────

test("editing details after claim updates name on page", async ({ page }) => {
  await gotoPartyLinkPage(page, link.token);

  const firstCard = page.locator('[data-testid^="party-slot-card-"]').first();

  // Claim the first slot
  await firstCard
    .getByTestId("party-claim-btn")
    .evaluate((el) => (el as HTMLButtonElement).click());
  await firstCard.getByTestId("party-claim-name").fill("E2E Bob");
  await firstCard.getByTestId("party-claim-phone").fill("+16045550002");
  await firstCard.getByTestId("party-claim-submit").click();
  await expect(firstCard.getByTestId("party-claim-btn")).not.toBeVisible({ timeout: 10_000 });
  // After claim, submitted name should appear immediately — not generic "Confirmed".
  await expect(firstCard.getByText("E2E Bob")).toBeVisible({ timeout: 10_000 });

  // Open edit form
  await firstCard
    .getByTestId("party-edit-btn")
    .evaluate((el) => (el as HTMLButtonElement).click());

  // Fill new name and phone in the edit form (phone is required by editPartyClaimDetails).
  await expect(firstCard.getByTestId("party-edit-name")).toBeVisible({ timeout: 5_000 });
  await firstCard.getByTestId("party-edit-name").fill("E2E Bob Updated");
  await firstCard.getByTestId("party-edit-phone").fill("+16045550099");

  // Submit edit
  await firstCard
    .getByTestId("party-edit-submit")
    .evaluate((el) => (el as HTMLButtonElement).click());

  // Edit form closes after success (edit button visible, form hidden).
  await expect(firstCard.getByTestId("party-edit-btn")).toBeVisible({ timeout: 10_000 });

  // DB: member_name in the claim row should be updated.
  await expect
    .poll(
      async () => {
        const claims = await getPartyClaims(link.partyLinkId);
        return claims.some((c) => c.member_name === "E2E Bob Updated");
      },
      { timeout: 10_000, intervals: [500] },
    )
    .toBe(true);
});

// ─── Test 7: Submit change request ────────────────────────────────

test("change request is submitted and stored in DB", async ({ page }) => {
  await gotoPartyLinkPage(page, link.token);

  const firstCard = page.locator('[data-testid^="party-slot-card-"]').first();

  // Claim the slot to unlock post-claim controls.
  await firstCard
    .getByTestId("party-claim-btn")
    .evaluate((el) => (el as HTMLButtonElement).click());
  await expect(firstCard.getByTestId("party-claim-name")).toBeVisible({ timeout: 10_000 });
  await firstCard.getByTestId("party-claim-name").fill("E2E Carol");
  await firstCard.getByTestId("party-claim-phone").fill("+16045550003");
  await firstCard.getByTestId("party-claim-submit").evaluate((el) => (el as HTMLButtonElement).click());
  // After claim, submitted name appears immediately.
  await expect(firstCard.getByText("E2E Carol")).toBeVisible({ timeout: 10_000 });

  // Open change request form
  await firstCard
    .getByTestId("party-change-req-btn")
    .evaluate((el) => (el as HTMLButtonElement).click());

  // Click the first request type pill
  const typePill = firstCard.locator("button[type='button']").filter({
    hasText: /request|message salon/i,
  }).first();
  await expect(typePill).toBeVisible({ timeout: 5_000 });
  await typePill.evaluate((el) => (el as HTMLButtonElement).click());

  // Submit
  await firstCard
    .getByTestId("party-change-req-submit")
    .evaluate((el) => (el as HTMLButtonElement).click());

  // Success message appears
  await expect(firstCard.getByTestId("party-change-req-success")).toBeVisible({ timeout: 10_000 });

  // DB: change request row should exist with status "pending"
  await expect
    .poll(
      async () => {
        const reqs = await getChangeRequests(link.partyLinkId);
        return reqs.some((r) => r.status === "pending");
      },
      { timeout: 10_000, intervals: [500] },
    )
    .toBe(true);
});

// ─── Test 8: Unclaimed slots show Guest N placeholder ─────────────

test("unclaimed slots show Guest N placeholder on party link page", async ({ page }) => {
  await gotoPartyLinkPage(page, link.token);

  // Both slots should show a [data-testid="party-guest-label"] element
  // since neither slot is claimed in a fresh seeded link.
  const guestLabels = page.locator('[data-testid="party-guest-label"]');
  await expect(guestLabels).toHaveCount(2, { timeout: 10_000 });

  // Labels must match "Guest N" pattern (seeded helper sets client_name = "Guest N")
  const text0 = await guestLabels.nth(0).textContent();
  const text1 = await guestLabels.nth(1).textContent();
  expect(text0).toMatch(/guest\s*\d+/i);
  expect(text1).toMatch(/guest\s*\d+/i);

  // They must not be the same label (each slot gets its own number)
  expect(text0).not.toBe(text1);
});

// ─── Test 9: Claiming replaces Guest label with member name ───────

test("claiming a slot replaces Guest placeholder with member name", async ({ page }) => {
  await gotoPartyLinkPage(page, link.token);

  const firstCard = page.locator('[data-testid^="party-slot-card-"]').first();

  // Unclaimed: guest label is visible before claiming
  await expect(firstCard.locator('[data-testid="party-guest-label"]')).toBeVisible({
    timeout: 10_000,
  });

  // Claim the slot
  await firstCard
    .getByTestId("party-claim-btn")
    .evaluate((el) => (el as HTMLButtonElement).click());
  await firstCard.getByTestId("party-claim-name").fill("E2E Dana");
  await firstCard.getByTestId("party-claim-phone").fill("+16045550004");
  await firstCard.getByTestId("party-claim-submit").click();

  // After claiming: member name visible, guest label gone
  await expect(firstCard.getByText("E2E Dana")).toBeVisible({ timeout: 10_000 });
  await expect(
    firstCard.locator('[data-testid="party-guest-label"]'),
  ).not.toBeVisible({ timeout: 10_000 });
});
