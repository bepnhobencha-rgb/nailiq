/**
 * Party Booking — Web group booking E2E tests.
 *
 * Covers:
 *   - Test 1: Arrive together (sync_start) — full 5-step flow + Party Link on success
 *   - Test 2: Finish together (sync_finish) — switch mode + Party Link on success
 *   - Test 3: Success screen shows Party Link share box with a valid URL
 *
 * Run: npm run test:e2e -- e2e/party-booking/web-group-booking.spec.ts
 */
import { expect, test } from "@playwright/test";
import {
  cleanupPartyTestSalon,
  seedPartyTestSalon,
  type PartyTestSalon,
} from "./helpers";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
} from "../group-booking/helpers";

// ─── Fixture ──────────────────────────────────────────────────────

const SLUG_ARRIVE = "e2e-party-arrive";
const SLUG_FINISH = "e2e-party-finish";
let salonArrive: PartyTestSalon;
let salonFinish: PartyTestSalon;

test.beforeAll(async () => {
  [salonArrive, salonFinish] = await Promise.all([
    seedPartyTestSalon(SLUG_ARRIVE),
    seedPartyTestSalon(SLUG_FINISH),
  ]);
});

test.afterAll(async () => {
  await Promise.all([
    cleanupPartyTestSalon(SLUG_ARRIVE, salonArrive?.salonId),
    cleanupPartyTestSalon(SLUG_FINISH, salonFinish?.salonId),
  ]);
});

// ─── Shared: complete the group booking form steps 1–5 ────────────

async function completeGroupFlow(
  page: Parameters<typeof gotoGroupFlow>[0],
  slug: string,
  opts: { syncFinish?: boolean } = {},
) {
  await gotoGroupFlow(page, slug);

  // STEP 1 — group size = 2
  await page.getByTestId("group-size-2").click();
  await page.getByTestId("group-size-next").click();

  // STEP 2 — services & staff
  await page.getByTestId("group-step-service-panel").waitFor({ state: "visible" });
  await fillMemberCard(page, 0, "E2E Mai", 1, 1);
  await fillMemberCard(page, 1, "E2E Linh", 1, 2);
  await page.getByTestId("group-service-next").click();

  // STEP 3 — date + sync mode
  await page.getByTestId("group-step-date-panel").waitFor({ state: "visible" });
  if (opts.syncFinish) {
    // Switch to "Finish together" before picking the date.
    const finishToggle = page.getByTestId("group-sync-finish");
    await finishToggle.waitFor({ state: "visible" });
    await finishToggle.click();
  }
  await pickDateInCalendar(page, nextOpenDateYmd());
  if (opts.syncFinish) {
    // Finish mode shows a target finish-time input instead of arrival windows.
    await page.getByTestId("group-finish-time").fill("16:00");
  } else {
    await page.getByTestId("group-arrival-afternoon").click();
  }
  await page.getByTestId("group-date-next").click();

  // STEP 4 — AI arrangement (scheduler RPC)
  await page.getByTestId("group-step-arrangement-panel").waitFor({ state: "visible" });
  await expect(page.getByTestId("group-arrangement-best")).toBeVisible({ timeout: 25_000 });
  await page.getByTestId("group-arrangement-best").click();
  await page.getByTestId("group-arrangement-next").click();

  // STEP 5 — contact + submit
  await page.getByTestId("group-step-confirm-panel").waitFor({ state: "visible" });
  await page.getByTestId("group-primary-phone").fill("+16045551234");
  // The phone-first gate normally captures SMS consent. The confirm-step
  // checkbox is a fallback only, so it is intentionally absent in that case.
  const groupSmsConsent = page.getByTestId("group-sms-consent");
  if (await groupSmsConsent.isVisible()) {
    await groupSmsConsent.check();
  }
  await page.getByTestId("group-confirm").click();

  // Wait for success
  await expect(page.getByTestId("booking-group-success")).toBeVisible({ timeout: 20_000 });
}

// ─── Test 1: Arrive together ─────────────────────────────────────

test("group booking Arrive Together — success + Party Link generated", async ({ page }) => {
  await completeGroupFlow(page, SLUG_ARRIVE);

  // Reference number visible
  await expect(page.getByTestId("group-success-reference")).toBeVisible();
  await expect(page.getByTestId("group-success-reference")).toContainText(/GRP/i);

  // Party Link share box appears asynchronously (createPartyLink is non-blocking)
  await expect(page.getByTestId("party-link-share")).toBeVisible({ timeout: 15_000 });

  // URL input contains /party/
  const urlInput = page.getByTestId("party-link-url");
  await expect(urlInput).toBeVisible();
  const url = await urlInput.inputValue();
  expect(url).toMatch(/\/party\/[0-9a-f]{16}/);

  // Copy button is present
  await expect(page.getByTestId("party-link-copy-btn")).toBeVisible();
});

// ─── Test 2: Finish together ─────────────────────────────────────

test("group booking Finish Together — success + Party Link generated", async ({ page }) => {
  await completeGroupFlow(page, SLUG_FINISH, { syncFinish: true });

  await expect(page.getByTestId("booking-group-success")).toBeVisible({ timeout: 20_000 });

  // Party Link may appear even in sync_finish mode
  await expect(page.getByTestId("party-link-share")).toBeVisible({ timeout: 15_000 });
  const url = await page.getByTestId("party-link-url").inputValue();
  expect(url).toMatch(/\/party\/[0-9a-f]{16}/);
});

// ─── Test 3: Party Link URL is navigable ─────────────────────────

test("Party Link URL from success screen leads to a valid claim page", async ({
  page,
  context,
}) => {
  await completeGroupFlow(page, SLUG_ARRIVE);

  await expect(page.getByTestId("party-link-share")).toBeVisible({ timeout: 15_000 });
  const url = await page.getByTestId("party-link-url").inputValue();
  expect(url).toBeTruthy();

  // Open the party link in a new tab.
  const newPage = await context.newPage();
  await newPage.goto(url);

  // Party claim page loads with at least one slot card.
  await expect(
    newPage.locator('[data-testid^="party-slot-card-"]').first(),
  ).toBeVisible({ timeout: 15_000 });

  await newPage.close();
});
