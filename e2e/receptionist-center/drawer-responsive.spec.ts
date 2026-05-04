import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  RECEPTIONIST_E2E_SLUG,
  seedDeskBooking,
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

test.describe("Booking detail drawer — viewport (Issue #9)", () => {
  test("dr-1: Drawer fits 1456px viewport — drawer and actions in viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1456, height: 900 });

    const marker = testClientNameMarker();
    const startIso = new Date(`${fx.ymdUtc}T12:00:00.000Z`).toISOString();
    const endIso = new Date(`${fx.ymdUtc}T12:55:00.000Z`).toISOString();
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso,
      endIso,
      status: "confirmed",
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc });

    await page.getByTestId(`booking-block-${bookingId}`).click();
    const drawer = page.getByTestId("booking-detail-drawer");
    await expect(drawer).toBeVisible();
    /** Portaled drawer + manual rect math was flaky; Playwright viewport checks match user-visible fit. */
    await expect(drawer).toBeInViewport();
    await expect(page.getByTestId("drawer-primary-action")).toBeInViewport();
    await expect(page.getByTestId("drawer-cancel-booking")).toBeInViewport();
  });

  test("dr-2: Drawer fits mobile viewport — full width, actions visible", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const marker = testClientNameMarker();
    const startIso = new Date(`${fx.ymdUtc}T12:00:00.000Z`).toISOString();
    const endIso = new Date(`${fx.ymdUtc}T12:55:00.000Z`).toISOString();
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso,
      endIso,
      status: "confirmed",
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc });

    await page.getByTestId(`booking-block-${bookingId}`).click();
    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();

    const drawer = page.getByTestId("booking-detail-drawer");
    const box = await drawer.boundingBox();
    const vw = page.viewportSize()?.width ?? 0;
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(vw - 2);
    }

    await expect(page.getByTestId("drawer-primary-action")).toBeInViewport();
    await expect(page.getByTestId("drawer-cancel-booking")).toBeInViewport();
  });

  test("dr-3: Edit form fits 1456px viewport — Save and Cancel visible", async ({ page }) => {
    await page.setViewportSize({ width: 1456, height: 900 });

    const marker = testClientNameMarker();
    const startIso = new Date(`${fx.ymdUtc}T12:00:00.000Z`).toISOString();
    const endIso = new Date(`${fx.ymdUtc}T12:55:00.000Z`).toISOString();
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso,
      endIso,
      status: "confirmed",
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc });

    await page.getByTestId(`booking-block-${bookingId}`).click();
    await page.getByTestId("edit-booking-button").click();
    await expect(page.getByTestId("edit-booking-form")).toBeVisible();

    await expect(page.getByTestId("edit-save-button")).toBeInViewport();
    await expect(page.getByTestId("edit-cancel-button")).toBeInViewport();
  });
});
