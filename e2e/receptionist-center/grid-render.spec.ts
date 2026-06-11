import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  clickWalkinService,
  clickWalkinSubmit,
  fillWalkinGuestContact,
  getBookingRow,
  gotoReceptionistCenter,
  moveMouseToAssignSlot,
  rcSlug,
  seedDeskBooking,
  seedReceptionistCenterFixture,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

function isoHm(h: number, m: number): string {
  const [y, mo, d] = fx.ymdUtc.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m, 0)).toISOString();
}

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

test.describe("Receptionist grid render + ghost", () => {
  test("case 5: seeded appointment renders on grid without walk-in border", async ({ page }) => {
    await gotoReceptionistCenter(page, fx.slug);

    const block = page.getByTestId(`booking-block-${fx.displayApptBookingId}`);
    await expect(block).toBeVisible({ timeout: 15_000 });

    const walkinBorder = await block.evaluate((el) =>
      window.getComputedStyle(el).borderLeftWidth,
    );
    expect(parseFloat(walkinBorder)).toBe(0);
  });

  test("case 6: cancel booking hides block and sets DB cancelled", async ({ page }) => {
    const marker = testClientNameMarker();
    const id = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso: isoHm(13, 0),
      endIso: isoHm(13, 55),
      status: "confirmed",
    });

    await gotoReceptionistCenter(page, fx.slug);

    const block = page.getByTestId(`booking-block-${id}`);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.click();

    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();

    page.once("dialog", (d) => d.accept());
    await page.getByTestId("drawer-cancel-booking").click();

    await expect(block).toHaveCount(0, { timeout: 15_000 });

    const row = await getBookingRow(fx.salonId, id);
    expect(row?.status).toBe("cancelled");
  });

  test("case 11: ghost preview states — ok, conflict, overflow", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "Ghost hover requires a fine pointer; covered on chromium desktop.",
    );

    await gotoReceptionistCenter(page, fx.slug);
    const marker = testClientNameMarker();

    await fillWalkinGuestContact(page, marker);
    await clickWalkinService(page, fx.longServiceId);
    await clickWalkinSubmit(page);

    const row = page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const tid = await row.getAttribute("data-testid");
    const bookingId = tid?.replace(/^queue-item-/, "") ?? "";
    await page.getByTestId(`queue-assign-${bookingId}`).click();

    await moveMouseToAssignSlot(page, fx.freeStaffId, fx.noonSlotIndex);
    await expect(page.getByTestId("ghost-block")).toHaveAttribute("data-state", "ok");

    await moveMouseToAssignSlot(page, fx.conflictStaffId, fx.conflictSlotIndex);
    await expect(page.getByTestId("ghost-block")).toHaveAttribute("data-state", "conflict");

    // Overflow = a long service whose span runs past the grid's end. The grid
    // window is now DYNAMIC (it widens to include "now" + off-hours bookings),
    // so a hardcoded slot index stops overflowing when CI runs late in the UTC
    // day and the grid has grown. Drag to the LAST rendered slot instead — a
    // multi-slot service starting there always overflows, whatever the width.
    const slotCount = await page
      .locator(`[data-testid^="assign-slot-${fx.freeStaffId}-"]`)
      .count();
    const overflowIdx = Math.max(0, slotCount - 1);
    await moveMouseToAssignSlot(page, fx.freeStaffId, overflowIdx);
    await expect(page.getByTestId("ghost-block")).toHaveAttribute("data-state", "overflow");
  });
});
