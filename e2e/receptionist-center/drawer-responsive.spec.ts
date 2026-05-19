import { test, expect, type Page } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { USER_LANGUAGE_STORAGE_KEY } from "@/shared/i18n/user/types";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  isoAtUtcYmdHourMinute,
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

test.describe("Booking detail drawer — service buffer hint (Issue #12)", () => {
  async function presetUserLang(page: Page, lang: "en" | "vi") {
    await page.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
      },
      { key: USER_LANGUAGE_STORAGE_KEY, value: lang },
    );
  }

  test("bd-1: Schedule shows service end + buffer note when buffer_minutes > 0 (English)", async ({
    page,
  }) => {
    await presetUserLang(page, "en");

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
    const scheduleEl = page.getByTestId("booking-drawer-schedule");
    await expect(scheduleEl).toBeVisible();
    await expect(scheduleEl).toContainText("12:45 PM");
    await expect(scheduleEl).not.toContainText("12:55 PM");
    await expect(scheduleEl).toContainText("+ 10 min buffer");
  });

  test("bd-1-vi: Buffer note Vietnamese copy", async ({ page }) => {
    await presetUserLang(page, "vi");

    const marker = testClientNameMarker();
    const startIso = new Date(`${fx.ymdUtc}T12:30:00.000Z`).toISOString();
    const endIso = new Date(`${fx.ymdUtc}T13:25:00.000Z`).toISOString();
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
    const scheduleEl = page.getByTestId("booking-drawer-schedule");
    await expect(scheduleEl).toBeVisible();
    await expect(scheduleEl).toContainText(" — ");
    await expect(scheduleEl).toContainText("1:15 PM");
    await expect(scheduleEl).not.toContainText("1:25 PM");
    await expect(scheduleEl).toContainText("+ 10 phút chuẩn bị (buffer)");
  });

  test("bd-2: No buffer note when buffer_minutes === 0", async ({ page }) => {
    await presetUserLang(page, "en");

    const marker = testClientNameMarker();
    /** Long Overflow Service — duration 240, buffer 0 */
    const startIso = isoAtUtcYmdHourMinute(fx.ymdUtc, 12, 0);
    const endIso = isoAtUtcYmdHourMinute(fx.ymdUtc, 16, 0);
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[5]!,
      staffId: fx.freeStaffId,
      startIso,
      endIso,
      status: "confirmed",
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc });

    await page.getByTestId(`booking-block-${bookingId}`).click();
    const scheduleEl = page.getByTestId("booking-drawer-schedule");
    await expect(scheduleEl).toBeVisible();
    await expect(scheduleEl).toContainText("4:00 PM");
    await expect(scheduleEl).not.toContainText("min buffer");
    await expect(scheduleEl).not.toContainText("phút chuyển ca");
  });
});
