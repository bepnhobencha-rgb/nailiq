import { expect, test, type Page } from "@playwright/test";

import {
  cleanupClientProfile,
  cleanupTestSalon,
  gotoBookingServiceStep,
  seedTestSalon,
  setReactInputValue,
} from "./helpers/db";
import {
  advanceBookingStep,
  selectAvailableBookingDate,
} from "./helpers/bookingFlow";

async function navigateToBookingInfo(page: Page, testSlug: string) {
  // Phone-first entry gate (PR #328): a phone is entered at the gate, so the
  // info step collects only the name.
  await gotoBookingServiceStep(page, testSlug);
  const serviceStep = page.locator(
    'section[aria-labelledby="svc-heading"]',
  );
  await serviceStep
    .locator('[data-testid="service-tile-select"]')
    .first()
    .click();
  await serviceStep.getByRole("button", { name: "Continue" }).click();

  const staffStep = page.locator(
    'section[aria-labelledby="staff-heading"]',
  );
  await staffStep
    .locator('[data-testid="staff-item"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await staffStep.locator('[data-testid="staff-item"]').first().click();
  await staffStep.getByRole("button", { name: "Continue" }).click();

  const dateStep = page.locator(
    'section[aria-labelledby="date-heading"]',
  );
  await selectAvailableBookingDate(page);
  await dateStep.getByRole("button", { name: "Continue" }).click();

  const timeStep = page.locator(
    'section[aria-labelledby="time-heading"]',
  );
  await timeStep
    .locator('[data-testid="time-slot"]')
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  const firstSlot = timeStep.locator('[data-testid="time-slot"]').first();
  await firstSlot.click();
  await expect(firstSlot).toHaveAttribute("aria-pressed", "true");
  await advanceBookingStep(
    timeStep,
    page.getByTestId("booking-info-name"),
  );
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

  test("bv-1: invalid phone at the entry gate keeps the flow gated", async ({ page }) => {
    // Phone-first: phone validation moved to the entry gate. A partial number
    // survives formatPhoneInputProgressive but fails validateGuestPhone, so the
    // individual flow (service step) must never mount.
    await page.goto(`/${testSlug}`);
    await expect(page.getByTestId("booking-phone-gate")).toBeVisible();
    await setReactInputValue(page.getByTestId("booking-entry-phone"), "123");
    await expect(page.getByTestId("booking-entry-phone")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByTestId("booking-entry-phone-error")).toBeVisible();
    await expect(
      page.locator('[data-testid="service-tile-select"]'),
    ).toHaveCount(0);
  });

  test("bv-2: valid phone formats at the gate reveal the service step", async ({ page }) => {
    await page.goto(`/${testSlug}`);
    await expect(page.getByTestId("booking-phone-gate")).toBeVisible();

    const phoneInput = page.getByTestId("booking-entry-phone");
    const smsConsent = page.getByTestId("sms-consent");
    const nameInput = page.getByTestId("booking-entry-name");

    // CountryPhoneField accepts the national number (no country code prefix).
    // Three NANP formats to verify the validator handles different notations.
    const formats = ["6045551234", "7788680738", "(604) 555-9999"];
    // `client_profiles` is global rather than salon-scoped. Earlier Chromium
    // specs create a profile for 6045551234, so the later mobile project can
    // legitimately recognize it, hide the new-customer name field, and make
    // this format-validation test time out. Pin all three identities to the
    // new-customer path before asserting the gate behavior.
    await Promise.all(formats.map((phone) => cleanupClientProfile(phone)));
    let gateUnlocked = false;

    for (const fmt of formats) {
      await setReactInputValue(phoneInput, "");
      await setReactInputValue(phoneInput, fmt);

      if (!gateUnlocked) {
        // First valid phone: satisfy the gate so the flow can mount. Wait on the
        // NAME input, not the consent checkbox — the checkbox renders on load and
        // resolves instantly, so the old `if (nameInput.isVisible())` ran before
        // the ~400ms customer lookup revealed the name input, left the name empty,
        // and the gate stayed closed. Name + consent persist across phone changes.
        await nameInput.waitFor({ state: "visible", timeout: 8_000 });
        await nameInput.fill("Test Guest");
        await smsConsent.check();
        gateUnlocked = true;
      }

      await expect(
        page.locator('[data-testid="service-tile-select"]').first(),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("bv-3: empty / whitespace-only name fails; valid name clears error", async ({ page }) => {
    // Phone-first: phone already captured at the gate; the info step gates only
    // on the name.
    await navigateToBookingInfo(page, testSlug);

    // Gate pre-fills name ("Test Guest"); clear it so blur validates an empty field.
    await page.getByTestId("booking-info-name").fill("");
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toBeVisible();

    await page.getByTestId("booking-info-name").fill("   ");
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toBeVisible();

    await page.getByTestId("booking-info-name").fill("Jane");
    await page.getByTestId("booking-info-name").blur();
    await expect(page.getByTestId("booking-info-name-error")).toHaveCount(0);

    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    await page.getByRole("button", { name: "Continue" }).first().click();

    await expect(page.getByRole("button", { name: "Confirm booking" })).toBeVisible({
      timeout: 12_000,
    });
  });

  test("bv-4: name max length boundary", async ({ page }) => {
    await navigateToBookingInfo(page, testSlug);

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
