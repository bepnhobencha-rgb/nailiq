/**
 * E2E tests for the phone OTP verification step in the booking flow.
 * Requires DEMO_OTP=true (set in .env.test.local) — uses magic code 000000.
 */
import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { fillReactInput } from "./receptionist-center/helpers";

const OTP_DEMO_CODE = "000000";

test.describe("Booking Flow — Phone OTP", () => {
  let testSlug: string;

  test.beforeEach(async () => {
    const { slug } = await seedTestSalon({
      slug: "e2e-otp-salon",
      name: "E2E OTP Salon",
      phone: "16045550001",
      phone_otp_enabled: true,
      // always_otp ensures the verify-decision RPC routes every booking through
      // the OTP step regardless of risk score (needed for predictable E2E tests).
      booking_verification_mode: "always_otp",
    });
    testSlug = slug;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  async function walkToInfoStep(page: import("@playwright/test").Page) {
    await page.goto(`/${testSlug}`);

    await page
      .locator('[data-testid="service-tile-select"]')
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    await page
      .locator('[data-testid="staff-item"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-testid="staff-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    await page
      .locator('[data-testid="date-day"]:not([disabled])')
      .nth(1)
      .waitFor({ state: "visible", timeout: 15_000 });
    await page
      .locator('[data-testid="date-day"]:not([disabled])')
      .nth(1)
      .click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    await page
      .locator('[data-testid="time-slot"]')
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.locator('[data-testid="time-slot"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    // Fill info form — use native setter so React's controlled onChange fires.
    // page.fill() uses CDP which bypasses React's patched value getter.
    await fillReactInput(page.locator('input[name="clientName"]'), "OTP Test Client");
    await fillReactInput(page.locator('input[name="clientPhone"]'), "6045559999");
  }

  test("OTP step appears after info and accepts demo code", async ({ page }) => {
    await walkToInfoStep(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    // Should be on OTP step — heading must mention verification / phone
    await expect(
      page.getByText(/xác thực|verify|verification/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Enter demo code
    await page.locator("#otp-code").waitFor({ state: "visible", timeout: 10_000 });
    await page.fill("#otp-code", OTP_DEMO_CODE);

    // Click verify button
    await page.getByRole("button", { name: /xác thực|verify/i }).last().click();

    // After OTP success → should advance to confirm step
    await expect(
      page.getByRole("button", { name: /confirm booking|xác nhận/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Wrong code shows error, correct code proceeds", async ({ page }) => {
    await walkToInfoStep(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    await page.locator("#otp-code").waitFor({ state: "visible", timeout: 10_000 });

    // Enter wrong code
    await page.fill("#otp-code", "999999");
    await page.getByRole("button", { name: /xác thực|verify/i }).last().click();

    // Error should appear
    await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 8_000 });

    // Fix with correct demo code
    await page.fill("#otp-code", OTP_DEMO_CODE);
    await page.getByRole("button", { name: /xác thực|verify/i }).last().click();

    await expect(
      page.getByRole("button", { name: /confirm booking|xác nhận/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Back button from OTP returns to info step", async ({ page }) => {
    await walkToInfoStep(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    await page.locator("#otp-code").waitFor({ state: "visible", timeout: 10_000 });

    // Click Back
    await page.getByRole("button", { name: /← back|back/i }).click();

    // Should be back on info step — name field visible
    await expect(page.locator('input[name="clientName"]')).toBeVisible({
      timeout: 8_000,
    });
  });

  test("Full booking completes after OTP verification", async ({ page }) => {
    await walkToInfoStep(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    // OTP step
    await page.locator("#otp-code").waitFor({ state: "visible", timeout: 10_000 });
    await page.fill("#otp-code", OTP_DEMO_CODE);
    await page.getByRole("button", { name: /xác thực|verify/i }).last().click();

    // Confirm step
    await page
      .getByRole("button", { name: /confirm booking|xác nhận/i })
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.getByRole("button", { name: /confirm booking|xác nhận/i }).click();

    // Success screen
    await expect(
      page.locator('[data-testid="booking-success"]'),
    ).toBeVisible({ timeout: 20_000 });
  });
});
