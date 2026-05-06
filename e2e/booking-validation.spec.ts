import { expect, test, type Page } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

async function navigateToBookingInfo(page: Page, testSlug: string) {
  await page.goto(`/${testSlug}`);
  await page.locator('[data-testid="service-item"]').first().click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.locator('[data-testid="staff-item"]').first().click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.locator('[data-testid="date-day"]:not([disabled])').nth(1).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page
    .locator('[data-testid="time-slot"]')
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  await page.locator('[data-testid="time-slot"]').first().click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("booking-info-phone")).toBeVisible();
}

test.describe("Booking validation — info step", () => {
  let testSlug: string;

  test.beforeEach(async () => {
    const { slug } = await seedTestSalon({
      phone: "15553334444",
      slug: "e2e-booking-validation",
      name: "E2E Validation Salon",
    });
    testSlug = slug;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("bv-1: invalid phone shows error on blur; Continue disabled", async ({ page }) => {
    await navigateToBookingInfo(page, testSlug);
    await page.getByTestId("booking-info-name").fill("Ada");
    await page.getByTestId("booking-info-phone").fill("abc");
    await page.getByTestId("booking-info-phone").blur();

    await expect(page.getByTestId("booking-info-phone-error")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("bv-2: valid phone formats enable Continue when name OK", async ({ page }) => {
    await navigateToBookingInfo(page, testSlug);
    await page.getByTestId("booking-info-name").fill("Ada");

    for (const fmt of ["6045551234", "+1 778 868 0738", "+84901234567"]) {
      await page.getByTestId("booking-info-phone").fill(fmt);
      await page.getByTestId("booking-info-phone").blur();

      await expect(page.getByTestId("booking-info-phone-error")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    }
  });

  test("bv-3: empty / whitespace-only name fails; valid name clears error", async ({ page }) => {
    await navigateToBookingInfo(page, testSlug);
    await page.getByTestId("booking-info-phone").fill("6045551234");

    await page.getByTestId("booking-info-name").focus();
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toBeVisible();

    await page.getByTestId("booking-info-name").fill("   ");
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toBeVisible();

    await page.getByTestId("booking-info-name").fill("Jane");
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toHaveCount(0);

    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("button", { name: "Confirm booking" })).toBeVisible({
      timeout: 12_000,
    });
  });

  test("bv-4: name max length boundary", async ({ page }) => {
    await navigateToBookingInfo(page, testSlug);
    await page.getByTestId("booking-info-phone").fill("6045551234");

    await page.getByTestId("booking-info-name").evaluate((el: HTMLInputElement) => {
      el.removeAttribute("maxLength");
      el.removeAttribute("maxlength");
    });
    await page.getByTestId("booking-info-name").fill("n".repeat(101));
    await page.getByTestId("booking-info-name").blur();

    await expect(page.getByTestId("booking-info-name-error")).toBeVisible();

    await page.getByTestId("booking-info-name").fill("n".repeat(100));
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});
