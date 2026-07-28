import { test, expect, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  GATE_PHONE,
  gotoBookingServiceStep,
  seedTestSalon,
} from "./helpers/db";
import { advanceBookingStep } from "./helpers/bookingFlow";

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

    await gotoBookingServiceStep(page, slug);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="staff-item"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-testid="staff-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    // Reveal the collapsed month grid (#593) before picking a grid day.
    await page.locator('[data-testid="date-toggle-calendar"]').click();
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
      .locator('[data-testid="time-slot"]:not([disabled])')
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    const timeStep = page.getByRole("group", { name: "Choose a time" });
    const firstSlot = timeStep
      .locator('[data-testid="time-slot"]:not([disabled])')
      .first();
    await firstSlot.click();
    await expect(firstSlot).toHaveAttribute("aria-pressed", "true");
    await advanceBookingStep(
      timeStep,
      page.getByTestId("booking-info-name"),
    );

    // Phone-first: the guest's phone is the one entered at the entry gate.
    const guestPhone = GATE_PHONE;
    await page.getByTestId("booking-info-name").fill("Security Test Guest");
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page.getByTestId("sms-consent").check();
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

    await gotoBookingServiceStep(page, slug);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="staff-item"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-testid="staff-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    // Reveal the collapsed month grid (#593) before picking a grid day.
    await page.locator('[data-testid="date-toggle-calendar"]').click();
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
      .locator('[data-testid="time-slot"]:not([disabled])')
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });
    const timeStep = page.getByRole("group", { name: "Choose a time" });
    const firstSlot = timeStep
      .locator('[data-testid="time-slot"]:not([disabled])')
      .first();
    await firstSlot.click();
    await expect(firstSlot).toHaveAttribute("aria-pressed", "true");
    await advanceBookingStep(
      timeStep,
      page.getByTestId("booking-info-name"),
    );

    // Phone-first: phone captured at the entry gate; info step takes name only.
    await page.getByTestId("booking-info-name").fill("Security Test Guest");
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page.getByTestId("sms-consent").check();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(
      page.locator('[data-testid="booking-success"]'),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId("booking-call-reschedule")).toHaveCount(0);
  });
});

async function navigateToBookingInfoStep(page: Page, testSlug: string) {
  await gotoBookingServiceStep(page, testSlug);
  await page.locator('[data-testid="service-tile-select"]').first().click();
  await page.getByRole("button", { name: "Continue" }).first().click();
  await page
    .locator('[data-testid="staff-item"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="staff-item"]').first().click();
  await page.getByRole("button", { name: "Continue" }).first().click();
  // Reveal the collapsed month grid (#593) before picking a grid day.
  await page.locator('[data-testid="date-toggle-calendar"]').click();
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
  const timeStep = page.locator(
    'section[aria-labelledby="time-heading"]',
  );
  const firstSlot = timeStep.locator('[data-testid="time-slot"]').first();
  await firstSlot.click();
  await expect(firstSlot).toHaveAttribute("aria-pressed", "true");
  await advanceBookingStep(
    timeStep,
    page.getByTestId("booking-info-name"),
  );
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
    // Phone-first: phone captured at the entry gate; info step takes name only.
    await page.getByTestId("booking-info-name").fill("Nguyễn Thị Mai");
    await page.getByRole("button", { name: "Continue" }).first().click();

    await expect(
      page.getByRole("button", { name: "Confirm booking" }),
    ).toBeVisible({ timeout: 12_000 });
    await page.getByTestId("sms-consent").check();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(page.getByTestId("booking-success")).toBeVisible({
      timeout: 15_000,
    });
  });
});
