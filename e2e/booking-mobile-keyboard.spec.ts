import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  cleanupClientProfile,
  cleanupTestSalon,
  enterBookingPhone,
  seedTestSalon,
} from "./helpers/db";
import {
  advanceBookingStep,
  selectAvailableBookingDate,
} from "./helpers/bookingFlow";

const SLUG = "e2e-mobile-keyboard-salon";
const GUEST_PHONE_DIGITS = "16045550931";
const KEYBOARD_OPEN_VIEWPORT = { width: 390, height: 430 };

async function expectFocusedControlIsUncovered(
  page: Page,
  control: Locator,
  label: string,
): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await control.click();
  await expect(control, `${label} must retain focus`).toBeFocused();

  const visibility = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const centerX = Math.min(
      viewportWidth - 1,
      Math.max(0, rect.left + rect.width / 2),
    );
    const centerY = Math.min(
      viewportHeight - 1,
      Math.max(0, rect.top + rect.height / 2),
    );
    const hit = document.elementFromPoint(centerX, centerY);

    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewportHeight,
      viewportWidth,
      hitIsControl:
        hit === element ||
        element.contains(hit) ||
        Boolean(hit?.contains(element)),
    };
  });

  expect(visibility.top, `${label} top edge`).toBeGreaterThanOrEqual(0);
  expect(visibility.left, `${label} left edge`).toBeGreaterThanOrEqual(0);
  expect(visibility.bottom, `${label} bottom edge`).toBeLessThanOrEqual(
    visibility.viewportHeight,
  );
  expect(visibility.right, `${label} right edge`).toBeLessThanOrEqual(
    visibility.viewportWidth,
  );
  expect(
    visibility.hitIsControl,
    `${label} interaction point must not be covered by another element`,
  ).toBe(true);
}

test.describe("MQA-0031 — mobile keyboard does not cover booking form", () => {
  test.beforeEach(async () => {
    await cleanupClientProfile(GUEST_PHONE_DIGITS);
    await seedTestSalon({
      slug: SLUG,
      name: "E2E Mobile Keyboard Salon",
      phone: "15553334444",
    });
  });

  test.afterEach(async () => {
    await cleanupTestSalon(SLUG);
    await cleanupClientProfile(GUEST_PHONE_DIGITS);
  });

  test("phone, name, email, notes and CTA remain reachable with keyboard-open viewport", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "MQA-0031 is certified by the configured iPhone WebKit project",
    );

    await page.goto(`/${SLUG}`);
    await page.getByTestId("booking-entry-hydrated").waitFor({
      state: "attached",
      timeout: 15_000,
    });

    // A software keyboard reduces the usable visual viewport while leaving the
    // booking page scrollable. Playwright cannot display the native iOS keyboard,
    // so this uses the configured iPhone WebKit project and its keyboard-open
    // visual height as the deterministic browser-automation equivalent.
    await page.setViewportSize(KEYBOARD_OPEN_VIEWPORT);

    const phone = page.getByTestId("booking-entry-phone");
    await expectFocusedControlIsUncovered(page, phone, "phone field");
    await enterBookingPhone(page, GUEST_PHONE_DIGITS);

    const gateName = page.getByTestId("booking-entry-name");
    await gateName.waitFor({ state: "visible", timeout: 8_000 });
    await expectFocusedControlIsUncovered(page, gateName, "entry name field");
    await gateName.fill("Keyboard QA Guest");
    await page.getByTestId("sms-consent").check();

    const service = page.locator('[data-testid="service-tile-select"]').first();
    await service.waitFor({ state: "visible", timeout: 15_000 });
    await service.click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    const staff = page.locator('[data-testid="staff-item"]').first();
    await staff.waitFor({ state: "visible", timeout: 15_000 });
    await staff.click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    await selectAvailableBookingDate(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    const slot = page
      .locator('[data-testid="time-slot"]:not([disabled])')
      .first();
    await slot.waitFor({ state: "visible", timeout: 20_000 });
    await slot.click();
    await expect(slot).toHaveAttribute("aria-pressed", "true");

    const timeStep = page.locator('section[aria-labelledby="time-heading"]');
    await advanceBookingStep(timeStep, page.getByTestId("booking-info-name"));

    const infoStep = page.getByRole("group", { name: "Your information" });
    const infoName = page.getByTestId("booking-info-name");
    const email = page.getByTestId("booking-info-email");
    const notes = page.locator('textarea[name="clientNotes"]');

    await expectFocusedControlIsUncovered(page, infoName, "information name field");
    await expectFocusedControlIsUncovered(page, email, "email field");
    await email.fill("keyboard-qa@example.com");
    await expectFocusedControlIsUncovered(page, notes, "notes field");
    await notes.fill("Keyboard-open viewport acceptance only; no booking submit.");

    const continueButton = infoStep.getByRole("button", { name: "Continue" });
    await continueButton.scrollIntoViewIfNeeded();
    await expect(continueButton).toBeVisible();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    // Reaching Confirm proves the CTA remained operable. Intentionally stop
    // before submission: this gate must not create a booking or call providers.
    await expect(page.getByTestId("confirm-booking-btn")).toBeVisible({
      timeout: 15_000,
    });
  });
});
