/**
 * Party Booking — Phone Privacy E2E tests.
 *
 * Covers:
 *   - Test 9: No phone numbers are visible on the public /party/[token] page —
 *             neither in the rendered HTML nor in the DOM after hydration.
 *
 * Run: npm run test:e2e -- e2e/party-booking/phone-privacy.spec.ts
 */
import { expect, test } from "@playwright/test";
import {
  cleanupPartyTestSalon,
  gotoPartyLinkPage,
  seedPartyLink,
  seedPartyTestSalon,
  type PartyTestSalon,
  type SeededPartyLink,
} from "./helpers";

const SLUG = "e2e-party-privacy";
let salon: PartyTestSalon;
let link: SeededPartyLink;

test.beforeAll(async () => {
  salon = await seedPartyTestSalon(SLUG);
  // Seed with a claimed slot so member_name is stored (but phone must not appear).
  link = await seedPartyLink({
    salonId: salon.salonId,
    staffIds: salon.staffIds,
    serviceIds: salon.serviceIds,
    slotCount: 2,
    hoursFromNow: 4,
  });
});

test.afterAll(async () => {
  await cleanupPartyTestSalon(SLUG, salon?.salonId);
});

// Phone digits that appear in seeded bookings (from seedPartyLink: 15550000000, 15550000001)
const SEEDED_PHONES = ["15550000000", "15550000001", "5550000000", "5550000001"];

test("phone numbers are not exposed in the party link page HTML", async ({ page }) => {
  await gotoPartyLinkPage(page, link.token);

  // Page is fully hydrated
  await expect(
    page.locator('[data-testid^="party-slot-card-"]').first(),
  ).toBeVisible({ timeout: 15_000 });

  // Grab full page source after hydration.
  const html = await page.content();

  for (const phone of SEEDED_PHONES) {
    expect(html, `Phone ${phone} should not appear in page HTML`).not.toContain(phone);
  }

  // No E.164-format phone numbers (±10 digit sequences not part of copy/URLs)
  // Exclude the help-text strings like "+1 (604)" that are in placeholder text.
  const phoneMatches = html.match(/\+1[2-9]\d{9}/g) ?? [];
  expect(phoneMatches, "No real E.164 phone numbers in page HTML").toHaveLength(0);
});

test("member_phone column name is not leaked in party link page", async ({ page }) => {
  await gotoPartyLinkPage(page, link.token);
  await expect(
    page.locator('[data-testid^="party-slot-card-"]').first(),
  ).toBeVisible({ timeout: 15_000 });

  const html = await page.content();
  expect(html).not.toContain("member_phone");
});

test("claimed member name is visible but phone is not", async ({ page }) => {
  // Claim a slot via the UI (name visible, phone must stay hidden).
  await gotoPartyLinkPage(page, link.token);
  const firstCard = page.locator('[data-testid^="party-slot-card-"]').first();
  await firstCard
    .getByTestId("party-claim-btn")
    .evaluate((el) => (el as HTMLButtonElement).click());
  await firstCard.getByTestId("party-claim-name").fill("PrivacyTest Alice");
  await firstCard.getByTestId("party-claim-phone").fill("+16045559999");
  await firstCard.getByTestId("party-claim-submit").click();

  // Slot transitions to claimed state
  await expect(firstCard.getByTestId("party-claim-btn")).not.toBeVisible({ timeout: 10_000 });
  await expect(firstCard.getByText("Confirmed")).toBeVisible({ timeout: 10_000 });

  // Phone is NOT in the page content after submit
  const html = await page.content();
  expect(html).not.toContain("6045559999");
  expect(html).not.toContain("+16045559999");
});
