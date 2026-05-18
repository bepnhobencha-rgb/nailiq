import { test, expect } from "./test";

import {
  cleanReceptionistData,
  clickAssignSlot,
  fillWalkinGuestContact,
  gotoReceptionistCenter,
  testClientNameMarker,
} from "./helpers";

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

test.describe("Undo toast", () => {
  test("case 13: countdown ticks and undo restores queue + removes grid block", async ({ page, rcFixture }) => {
    await gotoReceptionistCenter(page, rcFixture.slug);
    const marker = testClientNameMarker();

    await fillWalkinGuestContact(page, marker);
    await page.locator(`#walkin-service-${rcFixture.serviceIds[0]}`).click();
    await page.getByTestId("walkin-add-form").locator('button[type="submit"]').click();

    const row = page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const tid = await row.getAttribute("data-testid");
    const bookingId = tid?.replace(/^queue-item-/, "") ?? "";

    await page.getByTestId(`queue-assign-${bookingId}`).click();
    await clickAssignSlot(page, rcFixture.freeStaffId, rcFixture.noonSlotIndex);

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
