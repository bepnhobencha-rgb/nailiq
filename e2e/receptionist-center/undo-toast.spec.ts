import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  clickAssignSlot,
  clickWalkinService,
  clickWalkinSubmit,
  fillWalkinGuestContact,
  gotoReceptionistCenter,
  RECEPTIONIST_E2E_SLUG,
  seedReceptionistCenterFixture,
  testClientNameMarker,
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

test.describe("Undo toast", () => {
  test("case 13: countdown ticks and undo restores queue + removes grid block", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, fx.slug);
    const marker = testClientNameMarker();

    await fillWalkinGuestContact(page, marker);
    await clickWalkinService(page, fx.serviceIds[0]!);
    await clickWalkinSubmit(page);

    const row = page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const tid = await row.getAttribute("data-testid");
    const bookingId = tid?.replace(/^queue-item-/, "") ?? "";

    await page.getByTestId(`queue-assign-${bookingId}`).click();
    await clickAssignSlot(page, fx.freeStaffId, fx.noonSlotIndex);

    const toast = page.getByTestId("undo-toast");
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("undo-toast-undo")).toBeVisible();

    const countdown = toast.locator(".tabular-nums").filter({ hasText: /\d+s/ });
    await expect(countdown).toHaveText(/^5s$/);
    await page.waitForTimeout(1100);
    await expect(countdown).toHaveText(/^4s$/);

    await toast.getByTestId("undo-toast-undo").click();

    await expect(page.getByTestId(`booking-block-${bookingId}`)).toHaveCount(0);
    await expect(page.getByTestId(`queue-item-${bookingId}`)).toBeVisible({ timeout: 15_000 });
  });
});
