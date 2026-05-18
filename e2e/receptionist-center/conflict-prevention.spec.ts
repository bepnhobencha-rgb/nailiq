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

test.describe("Assign conflict prevention", () => {
  test("case 12: conflict slot shows desk message and keeps walk-in in queue", async ({ page, rcFixture }) => {
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

    await clickAssignSlot(page, rcFixture.conflictStaffId, rcFixture.conflictSlotIndex);

    await expect(page.getByTestId(`queue-item-${bookingId}`)).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId(`booking-block-${bookingId}`)).toHaveCount(0);
    await expect(page.getByTestId("desk-action-message")).toBeVisible({ timeout: 8000 });
  });
});
