import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  RECEPTIONIST_E2E_SLUG,
  seedReceptionistCenterFixture,
  type ReceptionistCenterFixture,
} from "./helpers";

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

test.describe("Walk-in name — XSS guard", () => {
  test("xss-2: Receptionist walk-in rejects script tag; submit disabled", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, fx.slug);
    // fill() bypasses Playwright's viewport actionability check (unlike .click()).
    // The walkin-name input sits inside the fixed-height overflow:hidden sidebar
    // and is "outside the viewport" on CI's 1280×720 — .click() retries for 90s.
    // fill() fires React's onChange (sets nameTouchedRef.current=true); press("Tab")
    // triggers the onBlur validator that sets nameError for the XSS pattern.
    await page.getByTestId("walkin-name").fill("<script>alert('XSS')</script>");
    await page.getByTestId("walkin-name").press("Tab");
    await page.getByTestId("walkin-phone").fill("6045550199");

    // 15s: CI can be slow to process blur→onBlur→setNameError chain
    await expect(page.getByTestId("walkin-name-error")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("walkin-add-form").locator('button[type="submit"]'),
    ).toBeDisabled();
  });
});
