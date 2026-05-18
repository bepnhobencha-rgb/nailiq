import { test, expect } from "./test";

import {
  cleanReceptionistData,
  gotoReceptionistCenter,
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

test.describe("Drawer phone link", () => {
  test("case 14: tel href present when phone set", async ({ page, rcFixture }) => {
    const marker = testClientNameMarker();
    const id = await seedDeskBooking(rcFixture.salonId, {
      clientName: marker,
      serviceId: rcFixture.serviceIds[0]!,
      staffId: rcFixture.freeStaffId,
      startIso: isoHm(rcFixture.ymdUtc, 13, 0),
      endIso: isoHm(rcFixture.ymdUtc, 13, 55),
      status: "confirmed",
      clientPhone: "6045550199",
    });

    await gotoReceptionistCenter(page, rcFixture.slug);
    await page.getByTestId(`booking-block-${id}`).click();

    const link = page.getByTestId("booking-call-link");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href ?? "").toMatch(/^tel:/);
    expect(href?.includes("6045550199") || href?.includes("16045550199")).toBeTruthy();
  });

  test("case 14: tel link absent when phone null", async ({ page, rcFixture }) => {
    const marker = testClientNameMarker();
    const id = await seedDeskBooking(rcFixture.salonId, {
      clientName: marker,
      serviceId: rcFixture.serviceIds[0]!,
      staffId: rcFixture.freeStaffId,
      startIso: isoHm(rcFixture.ymdUtc, 13, 0),
      endIso: isoHm(rcFixture.ymdUtc, 13, 55),
      status: "confirmed",
      clientPhone: null,
    });

    await gotoReceptionistCenter(page, rcFixture.slug);
    await page.getByTestId(`booking-block-${id}`).click();

    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();
    await expect(page.getByTestId("booking-call-link")).toHaveCount(0);
  });
});
