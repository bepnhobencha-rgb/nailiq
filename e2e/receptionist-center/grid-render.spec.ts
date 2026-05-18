import { test, expect } from "./test";

import {
  cleanReceptionistData,
  fillWalkinGuestContact,
  getBookingRow,
  gotoReceptionistCenter,
  moveMouseToAssignSlot,
  seedDeskBooking,
  testClientNameMarker,
} from "./helpers";

function isoHm(ymdUtc: string, h: number, m: number): string {
  const [y, mo, d] = ymdUtc.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m, 0)).toISOString();
}

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

test.describe("Receptionist grid render + ghost", () => {
  test("case 5: seeded appointment renders on grid without walk-in border", async ({ page, rcFixture }) => {
    await gotoReceptionistCenter(page, rcFixture.slug);

    const block = page.getByTestId(`booking-block-${rcFixture.displayApptBookingId}`);
    await expect(block).toBeVisible({ timeout: 15_000 });

    const walkinBorder = await block.evaluate((el) =>
      window.getComputedStyle(el).borderLeftWidth,
    );
    expect(parseFloat(walkinBorder)).toBe(0);
  });

  test("case 6: cancel booking hides block and sets DB cancelled", async ({ page, rcFixture }) => {
    const marker = testClientNameMarker();
    const id = await seedDeskBooking(rcFixture.salonId, {
      clientName: marker,
      serviceId: rcFixture.serviceIds[0]!,
      staffId: rcFixture.freeStaffId,
      startIso: isoHm(rcFixture.ymdUtc, 13, 0),
      endIso: isoHm(rcFixture.ymdUtc, 13, 55),
      status: "confirmed",
    });

    await gotoReceptionistCenter(page, rcFixture.slug);

    const block = page.getByTestId(`booking-block-${id}`);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.click();

    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();

    page.once("dialog", (d) => d.accept());
    await page.getByTestId("drawer-cancel-booking").click();

    await expect(block).toHaveCount(0, { timeout: 15_000 });

    const row = await getBookingRow(rcFixture.salonId, id);
    expect(row?.status).toBe("cancelled");
  });

  test("case 11: ghost preview states — ok, conflict, overflow", async ({ page, rcFixture }, testInfo) => {
    test.skip(
      testInfo.project.name === "mobile",
      "Ghost hover requires a fine pointer; covered on chromium desktop.",
    );

    await gotoReceptionistCenter(page, rcFixture.slug);
    const marker = testClientNameMarker();

    await fillWalkinGuestContact(page, marker);
    await page.locator(`#walkin-service-${rcFixture.longServiceId}`).click();
    await page.getByTestId("walkin-add-form").locator('button[type="submit"]').click();

    const row = page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const tid = await row.getAttribute("data-testid");
    const bookingId = tid?.replace(/^queue-item-/, "") ?? "";
    await page.getByTestId(`queue-assign-${bookingId}`).click();

    await moveMouseToAssignSlot(page, rcFixture.freeStaffId, rcFixture.noonSlotIndex);
    await expect(page.getByTestId("ghost-block")).toHaveAttribute("data-state", "ok");

    await moveMouseToAssignSlot(page, rcFixture.conflictStaffId, rcFixture.conflictSlotIndex);
    await expect(page.getByTestId("ghost-block")).toHaveAttribute("data-state", "conflict");

    await moveMouseToAssignSlot(page, rcFixture.freeStaffId, rcFixture.overflowSlotIndex);
    await expect(page.getByTestId("ghost-block")).toHaveAttribute("data-state", "overflow");
  });
});
