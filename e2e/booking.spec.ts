import { test, expect } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

test.describe("Booking Flow", () => {
  let testSlug: string;

  test.beforeEach(async () => {
    const { slug } = await seedTestSalon({
      phone: "15553334444",
      slug: "e2e-booking-salon",
      name: "E2E Booking Salon",
    });
    testSlug = slug;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("Complete booking end-to-end", async ({ page }) => {
    await page.goto(`/${testSlug}`);

    await page.locator('[data-testid="service-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.locator('[data-testid="staff-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page
      .locator('[data-testid="date-day"]:not([disabled])')
      .nth(1)
      .click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page
      .locator('[data-testid="time-slot"]')
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.locator('[data-testid="time-slot"]').first().click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.fill('input[name="clientName"]', "Test Client");
    await page.fill('input[name="clientPhone"]', "6045551234");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(
      page.locator('[data-testid="booking-success"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/all set/i)).toBeVisible();
  });

  test("Time step lists slots for a future day", async ({ page }) => {
    await page.goto(`/${testSlug}`);

    await page.locator('[data-testid="service-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('[data-testid="staff-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page
      .locator('[data-testid="date-day"]:not([disabled])')
      .nth(1)
      .click();
    await page.getByRole("button", { name: "Continue" }).click();

    const slots = page.locator('[data-testid="time-slot"]');
    await expect(slots.first()).toBeVisible({ timeout: 20_000 });
    expect(await slots.count()).toBeGreaterThan(0);

    const raw = (await slots.first().textContent())?.trim() ?? "";
    expect(raw).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
  });

  test("Calendar shows today and selectable days", async ({ page }) => {
    await page.goto(`/${testSlug}`);

    await page.locator('[data-testid="service-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('[data-testid="any-staff-option"]').click();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.locator('[data-testid="date-today"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="date-day"]:not([disabled])').first(),
    ).toBeVisible();
  });
});
