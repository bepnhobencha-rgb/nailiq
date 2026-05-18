import { test, expect } from "./test";

import {
  cleanReceptionistData,
  gotoReceptionistCenter,
} from "./helpers";

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

test.describe("Walk-in name — XSS guard", () => {
  test("xss-2: Receptionist walk-in rejects script tag; submit disabled", async ({ page, rcFixture }) => {
    await gotoReceptionistCenter(page, rcFixture.slug);
    await page.getByTestId("walkin-name").fill("<script>alert('XSS')</script>");
    await page.getByTestId("walkin-name").blur();
    await page.getByTestId("walkin-phone").fill("6045550199");

    await expect(page.getByTestId("walkin-name-error")).toBeVisible();
    await expect(
      page.getByTestId("walkin-add-form").locator('button[type="submit"]'),
    ).toBeDisabled();
  });
});
