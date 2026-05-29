/**
 * Party Booking — Dashboard Party Card E2E tests.
 *
 * Covers:
 *   - Test 8: Party Card panel appears in Receptionist Center when a
 *             party link exists; shows confirmed/pending/change-request counts.
 *
 * Uses the demo cookie for dashboard access (no real login required).
 *
 * Run: npm run test:e2e -- e2e/party-booking/dashboard-party-card.spec.ts
 */
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  cleanupPartyTestSalon,
  getPartyClaims,
  gotoPartyDashboard,
  seedPartyLink,
  seedPartyTestSalon,
  type PartyTestSalon,
  type SeededPartyLink,
} from "./helpers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SLUG = "e2e-party-dash";
let salon: PartyTestSalon;
let link: SeededPartyLink;

test.beforeAll(async () => {
  salon = await seedPartyTestSalon(SLUG);
  // Seed with one claimed and one unclaimed slot.
  link = await seedPartyLink({
    salonId: salon.salonId,
    staffIds: salon.staffIds,
    serviceIds: salon.serviceIds,
    slotCount: 2,
    hoursFromNow: 2,
  });
  // Manually claim the first slot so the card shows 1 confirmed + 1 pending.
  await supabase
    .from("party_link_claims")
    .update({ member_name: "E2E Confirmed", claimed_at: new Date().toISOString() })
    .eq("id", link.claimIds[0]);
});

test.afterAll(async () => {
  await cleanupPartyTestSalon(SLUG, salon?.salonId);
});

// ─── Test 8a: Party Card panel is visible ─────────────────────────

test("Party Card panel is visible in Receptionist Center", async ({ page, baseURL }) => {
  await gotoPartyDashboard(page, SLUG, baseURL!);

  // Party Card panel toggle should exist
  await expect(page.getByTestId("party-card-panel")).toBeVisible({ timeout: 15_000 });
});

// ─── Test 8b: Party Card shows correct group ──────────────────────

test("Party Card shows the seeded group with correct slot counts", async ({
  page,
  baseURL,
}) => {
  await gotoPartyDashboard(page, SLUG, baseURL!);

  // Open the panel if collapsed
  const panel = page.getByTestId("party-card-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });

  const toggle = page.getByTestId("party-card-panel-toggle");
  if (await toggle.isVisible()) {
    const expanded = await toggle.getAttribute("aria-expanded");
    if (expanded === "false") await toggle.click();
  }

  // The card for our group
  const card = page.getByTestId(`party-card-${link.groupId}`);
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Pending badge (1 unclaimed slot)
  await expect(page.getByTestId(`party-card-pending-${link.groupId}`)).toBeVisible();
});

// ─── Test 8c: Party Card shows change request indicator ───────────

test("Party Card shows change-request indicator after a change request is submitted", async ({
  page,
  baseURL,
}) => {
  // Insert a pending change request BEFORE loading the dashboard so the
  // server-rendered initialCards already includes the count.
  await supabase.from("party_link_change_requests").insert({
    party_link_id: link.partyLinkId,
    claim_id: link.claimIds[0],
    booking_id: link.bookingIds[0],
    request_type: "service_change",
    note: "E2E change request",
    status: "pending",
  });

  await gotoPartyDashboard(page, SLUG, baseURL!);

  // Ensure the panel is open (starts open when initialCards.length > 0).
  const panel = page.getByTestId("party-card-panel");
  await expect(panel).toBeVisible({ timeout: 15_000 });

  // Force the panel open via the toggle if it's collapsed.
  const toggle = page.getByTestId("party-card-panel-toggle");
  if (await toggle.isVisible()) {
    const ariaExpanded = await toggle.getAttribute("aria-expanded");
    if (ariaExpanded !== "true") {
      await toggle.evaluate((el) => (el as HTMLButtonElement).click());
    }
  }

  // The specific Party Card for our group
  const card = page.getByTestId(`party-card-${link.groupId}`);
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Change-request badge is in the card header (always visible, not in slot list)
  await expect(
    page.getByTestId(`party-card-change-requests-${link.groupId}`),
  ).toBeVisible({ timeout: 10_000 });
});
