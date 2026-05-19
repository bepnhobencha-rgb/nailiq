import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  fillReactInput,
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
    // Use native HTMLInputElement.prototype setter + InputEvent to set the value.
    // This is the only reliable approach on CI: pressSequentially loses focus in
    // the overflow:hidden sidebar between characters; fill() bypasses React's
    // change detection. Both leave clientName="" and nameTouchedRef=false so
    // onBlur returns early with no error. The native-setter forces React onChange.
    await fillReactInput(page.getByTestId("walkin-name"), "<script>alert('XSS')</script>");
    // Dispatch focusout (bubbles → caught by React's root event delegation → calls onBlur).
    // React maps onBlur to focusout; plain 'blur' doesn't bubble so React never sees it.
    await page.getByTestId("walkin-name").evaluate((el: HTMLElement) => {
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: false }));
    });

    // 15s: CI can be slow to process focusout→onBlur→setNameError chain
    await expect(page.getByTestId("walkin-name-error")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("walkin-add-form").locator('button[type="submit"]'),
    ).toBeDisabled();
  });
});
