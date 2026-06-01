/**
 * E2E tests for the phone OTP verification step in the booking flow.
 * Requires DEMO_OTP=true (set in .env.test.local) — uses magic code 000000.
 */
import { test, expect } from "@playwright/test";
import {
  cleanupClientProfile,
  cleanupTestSalon,
  seedTestSalon,
} from "./helpers/db";
import { fillReactInput } from "./receptionist-center/helpers";

const OTP_DEMO_CODE = "000000";

/**
 * Unique guest phone per test.
 *
 * Each test must arrive as a brand-new customer (visit_count 0) so the
 * `always_otp` salon actually routes through OTP. A fixed phone accumulates
 * `visit_count` across CI runs in the cross-salon `client_profiles` table;
 * once it reaches >= 5 the RPC returns reason:"trusted_returning" and skips
 * OTP. A per-test phone (combined with the afterEach `cleanupClientProfile`)
 * keeps each run starting fresh and prevents the row from ever accumulating.
 *
 * Stays NANP-valid: area `604` + exchange `5xx` + 4 digits (both leading
 * groups in 2-9, per normalizeNanpDigits).
 */
let otpPhoneSeq = 0;
function uniqueOtpPhone(): string {
  const n = (Date.now() + otpPhoneSeq++) % 1_000_000;
  const exchange = 500 + (Math.floor(n / 10_000) % 100); // 500–599
  const last4 = String(n % 10_000).padStart(4, "0");
  return `604${exchange}${last4}`;
}

test.describe("Booking Flow — Phone OTP", () => {
  let testSlug: string;
  let clientPhone: string;

  test.beforeEach(async () => {
    clientPhone = uniqueOtpPhone();
    // Defensive: clear any stale profile for this phone before the test runs.
    await cleanupClientProfile(clientPhone);
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
    // Remove the guest profile so visit_count never accumulates across runs.
    await cleanupClientProfile(clientPhone);
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

    // Robust date pick (mirrors PR #211): the calendar opens on the first month
    // with availability, but late in the month the current view can hold only
    // "today" (rendered as `date-today`, not `date-day`). Advance a month until
    // a selectable `date-day` appears instead of assuming the default view has
    // one — keeps the OTP suite deterministic on the last day of the month.
    await page
      .locator('[data-testid="calendar-grid"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    const selectableDay = page
      .locator('[data-testid="date-day"]:not([disabled])')
      .first();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await selectableDay.waitFor({ state: "visible", timeout: 5_000 });
        break;
      } catch {
        const next = page.locator('[data-testid="calendar-next-month"]');
        if (!(await next.isEnabled().catch(() => false))) break;
        await next.click();
      }
    }
    await selectableDay.waitFor({ state: "visible", timeout: 15_000 });
    await selectableDay.click();
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
    await fillReactInput(page.locator('input[name="clientPhone"]'), clientPhone);
  }

  test("OTP step appears after info and accepts demo code", async ({ page }) => {
    await walkToInfoStep(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    // Should be on OTP step — heading must mention verification / phone
    await expect(
      page.getByText(/xác thực|verify|verification/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Wait until OTP is auto-sent (input disabled={!sent} until the send API resolves).
    // fillReactInput triggers React onChange on WebKit (page.fill uses CDP which
    // bypasses React's patched value getter).
    await expect(page.locator("#otp-code")).toBeEnabled({ timeout: 15_000 });
    await fillReactInput(page.locator("#otp-code"), OTP_DEMO_CODE);

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

    await expect(page.locator("#otp-code")).toBeEnabled({ timeout: 15_000 });

    // Enter wrong code
    await fillReactInput(page.locator("#otp-code"), "999999");
    await page.getByRole("button", { name: /xác thực|verify/i }).last().click();

    // Error should appear. Scope to the OTP error text instead of [role="alert"]:
    // the bare role selector also matches Next.js's global
    // <div role="alert" id="__next-route-announcer__">, tripping Playwright
    // strict mode (2 matches) intermittently — observed on the mobile project.
    await expect(
      page.getByText(/incorrect code|mã không đúng/i),
    ).toBeVisible({ timeout: 8_000 });

    // Fix with correct demo code
    await fillReactInput(page.locator("#otp-code"), OTP_DEMO_CODE);
    await page.getByRole("button", { name: /xác thực|verify/i }).last().click();

    await expect(
      page.getByRole("button", { name: /confirm booking|xác nhận/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Back button from OTP returns to info step", async ({ page }) => {
    await walkToInfoStep(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    await expect(page.locator("#otp-code")).toBeEnabled({ timeout: 15_000 });

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
    await expect(page.locator("#otp-code")).toBeEnabled({ timeout: 15_000 });
    await fillReactInput(page.locator("#otp-code"), OTP_DEMO_CODE);
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
