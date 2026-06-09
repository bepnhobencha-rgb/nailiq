/**
 * Party Booking — Individual booking regression test.
 *
 * Covers:
 *   - Test 11: Standard single-person booking still works end-to-end
 *              after all Party Booking changes were introduced.
 *
 * Uses the same step-by-step flow as the existing booking-validation.spec.ts
 * (the canonical reference for individual booking tests in this codebase).
 *
 * Run: npm run test:e2e -- e2e/party-booking/individual-regression.spec.ts
 */
import { expect, test } from "@playwright/test";
import {
  cleanupTestSalon,
  gotoBookingServiceStep,
  seedTestSalon,
} from "../helpers/db";

const SLUG = "e2e-party-individual";

test.beforeAll(async () => {
  await seedTestSalon({
    slug: SLUG,
    name: "E2E Individual Regression",
    phone: "15550009999",
  });
});

test.afterAll(async () => {
  await cleanupTestSalon(SLUG);
});

test("individual booking still works — golden path smoke test", async ({ page }) => {
  // Phone-first entry gate (PR #328): enter a phone before the service step.
  await gotoBookingServiceStep(page, SLUG);

  // ── Step 1: Select service ────────────────────────────────────
  // seedTestSalon creates "Gel Manicure" — use service-tile-select testid.
  await page.locator('[data-testid="service-tile-select"]').first().click();

  // Advance to staff step
  await page.getByRole("button", { name: /continue/i }).first().click();

  // ── Step 2: Select staff ──────────────────────────────────────
  await page
    .locator('[data-testid="staff-item"], [data-testid="any-staff-option"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page
    .locator('[data-testid="staff-item"], [data-testid="any-staff-option"]')
    .first()
    .click();

  // Advance to date step
  await page.getByRole("button", { name: /continue/i }).first().click();

  // ── Step 3: Pick date ─────────────────────────────────────────
  // Navigate to next month to ensure multiple available dates exist
  // (end-of-month runs may have few remaining non-disabled cells).
  const calendarNextBtn = page.getByTestId("calendar-next-month");
  await calendarNextBtn.waitFor({ state: "visible", timeout: 15_000 });
  await calendarNextBtn.click();

  // Pick the first available (non-disabled, non-today) date cell.
  await page
    .locator('[data-testid="date-day"]:not([disabled])')
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('[data-testid="date-day"]:not([disabled])').first().click();

  // Advance to time step
  await page.getByRole("button", { name: /continue/i }).first().click();

  // ── Step 4: Pick time slot ────────────────────────────────────
  await page
    .locator('[data-testid="time-slot"]')
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  await page.locator('[data-testid="time-slot"]').first().click();

  // Advance to info step
  await page.getByRole("button", { name: /continue/i }).first().click();

  // ── Step 5: Fill contact info ─────────────────────────────────
  // Phone-first: phone captured at the entry gate; info step takes name only.
  await expect(page.getByTestId("booking-info-name")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("booking-info-name").fill("E2E Regression User");

  // Advance to confirm step
  await page.getByRole("button", { name: /continue/i }).first().click();

  // ── Step 6: Confirm ───────────────────────────────────────────
  await expect(page.getByTestId("confirm-booking-btn")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("confirm-booking-btn").click();

  // ── Success screen ────────────────────────────────────────────
  await expect(page.getByTestId("booking-success")).toBeVisible({ timeout: 20_000 });

  // No party link share box (individual bookings don't create party links)
  await expect(page.getByTestId("party-link-share")).not.toBeVisible();
});
