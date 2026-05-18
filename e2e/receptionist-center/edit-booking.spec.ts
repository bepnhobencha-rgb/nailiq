import { test, expect } from "./test";

import {
  cleanReceptionistData,
  fetchBookingDeskSnapshot,
  gotoReceptionistCenter,
  isoAtUtcYmdHourMinute,
  seedDeskBooking,
  testClientNameMarker,
} from "./helpers";

/** Wall duration for desk row (matches `performEditBooking` / seed helpers). */
function endIsoFromDurationBuffer(startIso: string, durationMin: number, bufferMin: number): string {
  const totalMin = durationMin + bufferMin;
  return new Date(Date.parse(startIso) + totalMin * 60 * 1000).toISOString();
}

/** Slot grid `selectedTimeMinutes` (minutes from midnight) for UTC salon on fixture day. */
function salonMinutesUtc(hour: number, minute: number): number {
  return hour * 60 + minute;
}

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

test.describe("Receptionist desk — edit booking", () => {
  test("eb-1: Edit time successfully", async ({ page, rcFixture }) => {
    const staffX = rcFixture.conflictStaffId;
    const manicureSvc = rcFixture.serviceIds[1]!; /* E2E Polish Change — ~30m, $25 */
    const marker = testClientNameMarker();

    const start2pm = isoAtUtcYmdHourMinute(rcFixture.ymdUtc, 14, 0);
    const end2pm = endIsoFromDurationBuffer(start2pm, 30, 10);
    const bookingId = await seedDeskBooking(rcFixture.salonId, {
      clientName: marker,
      serviceId: manicureSvc,
      staffId: staffX,
      startIso: start2pm,
      endIso: end2pm,
      status: "pending",
    });

    await gotoReceptionistCenter(page, rcFixture.slug, { dateYmd: rcFixture.ymdUtc });
    await page.getByTestId(`booking-block-${bookingId}`).click();
    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();
    await expect(page.getByTestId("edit-booking-button")).toBeVisible();
    await page.getByTestId("edit-booking-button").click();
    await expect(page.getByTestId("edit-booking-form")).toBeVisible();

    await page
      .getByTestId("edit-time-select")
      .selectOption(String(salonMinutesUtc(15, 0)));

    await page.getByTestId("edit-save-button").click();

    await expect(page.getByTestId("edit-booking-form")).toHaveCount(0, { timeout: 15_000 });

    await expect
      .poll(async () => (await fetchBookingDeskSnapshot(rcFixture.salonId, bookingId))?.start_time_utc, {
        timeout: 25_000,
      })
      .toBe(isoAtUtcYmdHourMinute(rcFixture.ymdUtc, 15, 0));

    const block = page.getByTestId(`booking-block-${bookingId}`);
    await expect(block).toBeVisible();
    await expect(block).toContainText(/3:00\s*(PM)?/);
  });

  test("eb-2: Edit staff successfully", async ({ page, rcFixture }) => {
    const staffX = rcFixture.conflictStaffId;
    const staffY = rcFixture.freeStaffId;
    const svc = rcFixture.serviceIds[1]!;
    const marker = testClientNameMarker();

    const startIso = isoAtUtcYmdHourMinute(rcFixture.ymdUtc, 13, 0);
    const endIso = endIsoFromDurationBuffer(startIso, 30, 10);
    const bookingId = await seedDeskBooking(rcFixture.salonId, {
      clientName: marker,
      serviceId: svc,
      staffId: staffX,
      startIso,
      endIso,
      status: "pending",
    });

    await gotoReceptionistCenter(page, rcFixture.slug, { dateYmd: rcFixture.ymdUtc });
    await page.getByTestId(`booking-block-${bookingId}`).click();
    await page.getByTestId("edit-booking-button").click();
    await expect(page.getByTestId("edit-booking-form")).toBeVisible();

    await page.getByTestId("edit-staff-select").selectOption(staffY);
    await page.getByTestId("edit-save-button").click();

    await expect(page.getByTestId("edit-booking-form")).toHaveCount(0, { timeout: 15_000 });

    await expect
      .poll(async () => (await fetchBookingDeskSnapshot(rcFixture.salonId, bookingId))?.staff_id, {
        timeout: 25_000,
      })
      .toBe(staffY);

    /* Drawer stays open post-save — full-screen overlay on mobile blocks a second grid click */
    await expect(page.getByTestId("booking-detail-drawer")).toContainText("Sam");
  });

  test("eb-3: Edit service updates price + duration", async ({ page, rcFixture }) => {
    const staffX = rcFixture.conflictStaffId;
    const polishId = rcFixture.serviceIds[1]!;
    const deluxePedId = rcFixture.serviceIds[2]!;
    const marker = testClientNameMarker();

    const startIso = isoAtUtcYmdHourMinute(rcFixture.ymdUtc, 11, 0);
    const endIsoShort = endIsoFromDurationBuffer(startIso, 30, 10);
    const bookingId = await seedDeskBooking(rcFixture.salonId, {
      clientName: marker,
      serviceId: polishId,
      staffId: staffX,
      startIso,
      endIso: endIsoShort,
      status: "pending",
    });

    await gotoReceptionistCenter(page, rcFixture.slug, { dateYmd: rcFixture.ymdUtc });
    await page.getByTestId(`booking-block-${bookingId}`).click();
    await page.getByTestId("edit-booking-button").click();
    await expect(page.getByTestId("edit-booking-form")).toBeVisible();

    await page.getByTestId("edit-service-select").selectOption(deluxePedId);
    await page.getByTestId("edit-save-button").click();

    await expect(page.getByTestId("edit-booking-form")).toHaveCount(0, { timeout: 15_000 });

    const expectedEnd = endIsoFromDurationBuffer(startIso, 60, 15);

    await expect
      .poll(
        async () => {
          const row = await fetchBookingDeskSnapshot(rcFixture.salonId, bookingId);
          if (!row) return null;
          return {
            service_id: row.service_id,
            price_cents: row.price_cents,
            end_time_utc: row.end_time_utc,
          };
        },
        { timeout: 25_000 },
      )
      .toEqual({
        service_id: deluxePedId,
        price_cents: 6500,
        end_time_utc: new Date(expectedEnd).toISOString(),
      });

    const block = page.getByTestId(`booking-block-${bookingId}`);
    await expect(block).toBeVisible();
    /* Deluxe 60m + buffer 15m → wider block than Polish 30m + 10 (~81px rendered). */
    await expect.poll(async () => (await block.boundingBox())?.width ?? 0).toBeGreaterThan(110);
  });

  test("eb-4: Conflict prevented", async ({ page, rcFixture }) => {
    const staffX = rcFixture.conflictStaffId;
    const deluxeId = rcFixture.serviceIds[2]!;
    const polishId = rcFixture.serviceIds[1]!;

    const markerA = testClientNameMarker();
    const markerB = testClientNameMarker();

    const startA = isoAtUtcYmdHourMinute(rcFixture.ymdUtc, 14, 0);
    const endA = endIsoFromDurationBuffer(startA, 60, 15);
    const bookingAId = await seedDeskBooking(rcFixture.salonId, {
      clientName: markerA,
      serviceId: deluxeId,
      staffId: staffX,
      startIso: startA,
      endIso: endA,
      status: "pending",
    });

    const startB = isoAtUtcYmdHourMinute(rcFixture.ymdUtc, 16, 0);
    const endB = endIsoFromDurationBuffer(startB, 30, 10);
    await seedDeskBooking(rcFixture.salonId, {
      clientName: markerB,
      serviceId: polishId,
      staffId: staffX,
      startIso: startB,
      endIso: endB,
      status: "pending",
    });

    const beforeConflict = await fetchBookingDeskSnapshot(rcFixture.salonId, bookingAId);
    expect(beforeConflict).not.toBeNull();

    await gotoReceptionistCenter(page, rcFixture.slug, { dateYmd: rcFixture.ymdUtc });
    await page.getByTestId(`booking-block-${bookingAId}`).click();
    await page.getByTestId("edit-booking-button").click();
    await expect(page.getByTestId("edit-booking-form")).toBeVisible();

    await page.getByTestId("edit-time-select").selectOption(String(salonMinutesUtc(15, 30)));
    await page.getByTestId("edit-save-button").click();

    const err = page.getByTestId("edit-error-message");
    await expect(err).toBeVisible({ timeout: 15_000 });
    await expect(err).toContainText(markerB);

    const after = await fetchBookingDeskSnapshot(rcFixture.salonId, bookingAId);
    expect(after).toEqual(beforeConflict);
  });

  test("eb-5: Edit blocked for in_progress", async ({ page, rcFixture }) => {
    const taylorStaff = rcFixture.staffIds[2]!;
    const polishId = rcFixture.serviceIds[1]!;
    const marker = testClientNameMarker();

    const startIso = isoAtUtcYmdHourMinute(rcFixture.ymdUtc, 17, 0);
    const endIso = endIsoFromDurationBuffer(startIso, 30, 10);
    const bookingId = await seedDeskBooking(rcFixture.salonId, {
      clientName: marker,
      serviceId: polishId,
      staffId: taylorStaff,
      startIso,
      endIso,
      status: "in_progress",
    });

    await gotoReceptionistCenter(page, rcFixture.slug, { dateYmd: rcFixture.ymdUtc });
    await page.getByTestId(`booking-block-${bookingId}`).click();
    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();
    await expect(page.getByTestId("edit-booking-button")).toHaveCount(0);
  });
});
