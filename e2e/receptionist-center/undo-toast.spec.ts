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
    // Anchor on the full "5s" start, THEN assert the countdown ticks below 5.
    // Two traps this avoids:
    //   1. The toast span is always in the DOM and shows a frozen "0s" while the
    //      toast is closed (secondsRemaining defaults to 0), so a /^\ds$/ match
    //      would latch onto "0s" before the assign even opens the toast. Pinning
    //      "5s" waits (retry) for the real open frame.
    //   2. Pinning the next value to exact "4s" raced the second boundary — a
    //      late first read meant the value had already skipped to "3s". Polling
    //      for "< 5" is tick-accurate regardless of when in the second we read.
    await expect(countdown).toHaveText(/^5s$/);
    const readSeconds = async () =>
      parseInt((await countdown.textContent())!.replace(/\D/g, ""), 10);
    // Generous 8s timeout: the grid re-renders each tick, so under CI load the
    // countdown can stall briefly before the next decrement lands. We only need
    // to observe ONE tick below 5, whenever the main thread frees up.
    await expect.poll(readSeconds, { timeout: 8000 }).toBeLessThan(5);

    await toast.getByTestId("undo-toast-undo").click();

    await expect(page.getByTestId(`booking-block-${bookingId}`)).toHaveCount(0);
    await expect(page.getByTestId(`queue-item-${bookingId}`)).toBeVisible({ timeout: 15_000 });
  });
});
