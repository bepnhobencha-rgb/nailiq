import { test, expect, type Page } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  RECEPTIONIST_E2E_SLUG,
  seedReceptionistCenterFixture,
  type ReceptionistCenterFixture,
} from "./receptionist-center/helpers";

test.describe("Public booking — privacy (reschedule tel)", () => {
  const slug = "e2e-booking-security";

  test.afterEach(async () => {
    await cleanupTestSalon(slug);
  });

  test("sec-1: Call to reschedule uses salon_phone, not guest phone", async ({
    page,
  }) => {
    const salonPublicLine = "+17788680738";
    await seedTestSalon({
      phone: "15553334444",
      slug,
      name: "E2E Security Salon",
      salon_phone: salonPublicLine,
    });

    await page.goto(`/${slug}`);

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

    const guestPhone = "6045551234";
    await page.fill('input[name="clientName"]', "Security Test Guest");
    await page.fill('input[name="clientPhone"]', guestPhone);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(
      page.locator('[data-testid="booking-success"]'),
    ).toBeVisible({ timeout: 15_000 });

    const callLink = page.getByTestId("booking-call-reschedule");
    await expect(callLink).toBeVisible();

    const href = await callLink.getAttribute("href");
    expect(href ?? "").toMatch(/^tel:/);
    expect(href).toContain("7788680738");
    expect(href).not.toContain(
      guestPhone.replace(/\D/g, ""),
    );
  });

  test("sec-2: Call to reschedule hidden when salon_phone unset", async ({
    page,
  }) => {
    await seedTestSalon({
      phone: "15553334444",
      slug,
      name: "E2E Security Salon No Public Line",
      salon_phone: null,
    });

    await page.goto(`/${slug}`);

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

    await page.fill('input[name="clientName"]', "Security Test Guest");
    await page.fill('input[name="clientPhone"]', "6049876543");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(
      page.locator('[data-testid="booking-success"]'),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId("booking-call-reschedule")).toHaveCount(0);
  });
});

async function navigateToBookingInfoStep(page: Page, testSlug: string) {
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

  await expect(page.getByTestId("booking-info-name")).toBeVisible();
}

test.describe("Guest name — XSS / charset guard", () => {
  const slug = "e2e-booking-security-names";

  test.afterEach(async () => {
    await cleanupTestSalon(slug);
  });

  test("xss-1: script tag rejected on blur; Continue disabled", async ({
    page,
  }) => {
    await seedTestSalon({
      phone: "15553334444",
      slug,
      name: "E2E XSS Name Salon",
    });

    await navigateToBookingInfoStep(page, slug);
    await page.getByTestId("booking-info-name").fill(`<script>alert('XSS')</script>`);
    await page.getByTestId("booking-info-name").blur();

    await expect(page.getByTestId("booking-info-name-error")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("xss-3: Vietnamese Unicode name completes booking flow", async ({
    page,
  }) => {
    await seedTestSalon({
      phone: "15553334444",
      slug,
      name: "E2E VN Name Salon",
    });

    await navigateToBookingInfoStep(page, slug);
    await page.getByTestId("booking-info-name").fill("Nguyễn Thị Mai");
    await page.getByTestId("booking-info-phone").fill("6045551234");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("button", { name: "Confirm booking" }),
    ).toBeVisible({ timeout: 12_000 });
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(page.getByTestId("booking-success")).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe("Walk-in name — XSS guard", () => {
  let fx: ReceptionistCenterFixture;

  test.beforeAll(async () => {
    fx = await seedReceptionistCenterFixture();
  });

  test.beforeEach(async () => {
    await cleanReceptionistData(fx.salonId);
  });

  test.afterAll(async () => {
    await cleanupTestSalon(RECEPTIONIST_E2E_SLUG);
  });

  test("xss-2: Receptionist walk-in rejects script tag; submit disabled", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, fx.slug);
    await page.getByTestId("walkin-name").fill("<script>alert('XSS')</script>");
    await page.getByTestId("walkin-name").blur();
    await page.getByTestId("walkin-phone").fill("6045550199");

    await expect(page.getByTestId("walkin-name-error")).toBeVisible();
    await expect(
      page.getByTestId("walkin-add-form").locator('button[type="submit"]'),
    ).toBeDisabled();
  });
});
