import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
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

test.describe("Drawer phone link", () => {
  test("case 14: tel href present when phone set", async ({ page }) => {
    const marker = testClientNameMarker();
    const id = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso: isoHm(13, 0),
      endIso: isoHm(13, 55),
      status: "confirmed",
      clientPhone: "6045550199",
    });

    await gotoReceptionistCenter(page, fx.slug);
    await page.getByTestId(`booking-block-${id}`).click();

    const link = page.getByTestId("booking-call-link");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href ?? "").toMatch(/^tel:/);
    expect(href?.includes("6045550199") || href?.includes("16045550199")).toBeTruthy();
  });

  test("case 14: tel link absent when phone null", async ({ page }) => {
    const marker = testClientNameMarker();
    const id = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso: isoHm(13, 0),
      endIso: isoHm(13, 55),
      status: "confirmed",
      clientPhone: null,
    });

    await gotoReceptionistCenter(page, fx.slug);
    await page.getByTestId(`booking-block-${id}`).click();

    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();
    await expect(page.getByTestId("booking-call-link")).toHaveCount(0);
  });
});
