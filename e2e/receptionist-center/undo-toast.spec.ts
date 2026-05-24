import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  clickAssignSlot,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  seedWalkin,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

test.describe("Undo toast", () => {
  test("case 13: countdown ticks and undo restores queue + removes grid block", async ({
    page,
  }) => {
    // Seed walk-in directly (bypasses canAssignImmediately / walkin_auto_assign) so the
    // walk-in always starts in the waiting queue regardless of salon auto-assign setting.
    const marker = testClientNameMarker();
    const bookingId = await seedWalkin(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
    });

    await gotoReceptionistCenter(page, fx.slug);

    const row = page.getByTestId(`queue-item-${bookingId}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

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
