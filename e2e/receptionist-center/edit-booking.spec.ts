import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  fetchBookingDeskSnapshot,
  gotoReceptionistCenter,
  isoAtUtcYmdHourMinute,
  rcSlug,
  seedDeskBooking,
  seedReceptionistCenterFixture,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

/** Wall duration for desk row (matches `performEditBooking` / seed helpers). */
function endIsoFromDurationBuffer(startIso: string, durationMin: number, bufferMin: number): string {
  const totalMin = durationMin + bufferMin;
  return new Date(Date.parse(startIso) + totalMin * 60 * 1000).toISOString();
}

/** Slot grid minutes-from-midnight for the UTC salon (testid suffix on the
 *  new edit-time-slot buttons: `edit-time-slot-${minutes}`). */
function salonMinutesUtc(hour: number, minute: number): number {
  return hour * 60 + minute;
}

/**
 * A future salon-local (UTC) day, ≥ `daysAhead` from the fixture day, that is
 * NOT a Sunday (the default opening hours close Sunday → empty grid).
 *
 * Why a future day for the time tests: the availability grid hides past slots
 * (`isToday && slotStartMs < now + lead`). On the fixture day (= today UTC) the
 * set of selectable slots depends on the CI wall-clock — a late-UTC run would
 * leave the 09:00–18:00 grid empty. A near-future open day makes the WHOLE
 * opening-hours grid selectable regardless of when CI runs, and staffX has no
 * baseline bookings on it, so every open-hours slot is genuinely free.
 */
function futureOpenYmdUtc(fromYmd: string, daysAhead = 1): string {
  const [y, m, d] = fromYmd.split("-").map(Number);
  const base = Date.UTC(y, m - 1, d);
  for (let add = daysAhead; add < daysAhead + 7; add += 1) {
    const cand = new Date(base + add * 86_400_000);
    // getUTCDay: 0 = Sunday (closed in DEFAULT_OPENING_HOURS_JSON).
    if (cand.getUTCDay() !== 0) return cand.toISOString().slice(0, 10);
  }
  // Unreachable (a 7-day window always contains a non-Sunday).
  return new Date(base + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

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

test.describe("Receptionist desk — edit booking", () => {
  test("eb-1: Edit time successfully", async ({ page }) => {
    const staffX = fx.conflictStaffId;
    const manicureSvc = fx.serviceIds[1]!; /* E2E Polish Change — ~30m, $25 */
    const marker = testClientNameMarker();

    const start2pm = isoAtUtcYmdHourMinute(fx.ymdUtc, 14, 0);
    const end2pm = endIsoFromDurationBuffer(start2pm, 30, 10);
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: manicureSvc,
      staffId: staffX,
      startIso: start2pm,
      endIso: end2pm,
      status: "pending",
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc });
    await page.getByTestId(`booking-block-${bookingId}`).click();
    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();
    await expect(page.getByTestId("edit-booking-button")).toBeVisible();
    await page.getByTestId("edit-booking-button").click();
    await expect(page.getByTestId("edit-booking-form")).toBeVisible();

    // New time picker: pick a near-future open day so the WHOLE 09:00–18:00 grid
    // is selectable regardless of CI wall-clock (past slots are hidden on the
    // current day), then click a free slot. staffX has no bookings on that day,
    // so 11:00 is guaranteed free.
    const targetYmd = futureOpenYmdUtc(fx.ymdUtc);
    const targetMinutes = salonMinutesUtc(11, 0); /* 660 → "11:00 AM" */
    await page.getByTestId("edit-date-input").fill(targetYmd);

    const slot = page.getByTestId(`edit-time-slot-${targetMinutes}`);
    await expect(slot).toBeVisible({ timeout: 15_000 });
    await slot.click();

    await page.getByTestId("edit-save-button").click();

    await expect(page.getByTestId("edit-booking-form")).toHaveCount(0, { timeout: 15_000 });

    await expect
      .poll(async () => (await fetchBookingDeskSnapshot(fx.salonId, bookingId))?.start_time_utc, {
        timeout: 25_000,
      })
      .toBe(isoAtUtcYmdHourMinute(targetYmd, 11, 0));
  });

  test("eb-2: Edit staff successfully", async ({ page }) => {
    const staffX = fx.conflictStaffId;
    const staffY = fx.freeStaffId;
    const svc = fx.serviceIds[1]!;
    const marker = testClientNameMarker();

    const startIso = isoAtUtcYmdHourMinute(fx.ymdUtc, 13, 0);
    const endIso = endIsoFromDurationBuffer(startIso, 30, 10);
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: svc,
      staffId: staffX,
      startIso,
      endIso,
      status: "pending",
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc });
    await page.getByTestId(`booking-block-${bookingId}`).click();
    await page.getByTestId("edit-booking-button").click();
    await expect(page.getByTestId("edit-booking-form")).toBeVisible();

    await page.getByTestId("edit-staff-select").selectOption(staffY);
    await page.getByTestId("edit-save-button").click();

    await expect(page.getByTestId("edit-booking-form")).toHaveCount(0, { timeout: 15_000 });

    await expect
      .poll(async () => (await fetchBookingDeskSnapshot(fx.salonId, bookingId))?.staff_id, {
        timeout: 25_000,
      })
      .toBe(staffY);

    /* Drawer stays open post-save — full-screen overlay on mobile blocks a second grid click */
    await expect(page.getByTestId("booking-detail-drawer")).toContainText("Sam");
  });

  test("eb-3: Edit service updates price + duration", async ({ page }) => {
    const staffX = fx.conflictStaffId;
    const polishId = fx.serviceIds[1]!;
    const deluxePedId = fx.serviceIds[2]!;
    const marker = testClientNameMarker();

    const startIso = isoAtUtcYmdHourMinute(fx.ymdUtc, 11, 0);
    const endIsoShort = endIsoFromDurationBuffer(startIso, 30, 10);
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: polishId,
      staffId: staffX,
      startIso,
      endIso: endIsoShort,
      status: "pending",
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc });
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
          const row = await fetchBookingDeskSnapshot(fx.salonId, bookingId);
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

  test("eb-4: Conflict prevented (busy slot hidden, not selectable)", async ({ page }) => {
    // NEW prevention model: the refactored edit form renders ONLY free slots
    // (getAvailableTimeSlots). A receptionist therefore CANNOT pick a time that
    // collides with another booking — the busy slot simply never appears in the
    // grid. This replaces the old "select a busy slot → server returns
    // slot_conflict" flow, which is impossible now that the static dropdown is
    // gone. We assert the prevention happens at the UI layer (busy slot absent),
    // while a known-free slot on the same day/staff is still selectable.
    const staffX = fx.conflictStaffId;
    const deluxeId = fx.serviceIds[2]!; /* 60m + 15 buffer = 75m span */
    const polishId = fx.serviceIds[1]!; /* 30m + 10 buffer = 40m span */

    const markerA = testClientNameMarker();
    const markerB = testClientNameMarker();

    // Both bookings live on a near-future open day so the full grid is visible
    // (current-day past-slot hiding doesn't interfere) and staffX has no
    // baseline bookings there besides these two.
    const dayYmd = futureOpenYmdUtc(fx.ymdUtc);

    // Booking A — the one we edit. Sits at 11:00.
    const startA = isoAtUtcYmdHourMinute(dayYmd, 11, 0);
    const endA = endIsoFromDurationBuffer(startA, 60, 15);
    const bookingAId = await seedDeskBooking(fx.salonId, {
      clientName: markerA,
      serviceId: deluxeId,
      staffId: staffX,
      startIso: startA,
      endIso: endA,
      status: "pending",
    });

    // Booking B — occupies 15:00 on the SAME day/staff. Its start slot (900 min)
    // must be hidden from A's grid.
    const busyHour = 15;
    const startB = isoAtUtcYmdHourMinute(dayYmd, busyHour, 0);
    const endB = endIsoFromDurationBuffer(startB, 30, 10);
    await seedDeskBooking(fx.salonId, {
      clientName: markerB,
      serviceId: polishId,
      staffId: staffX,
      startIso: startB,
      endIso: endB,
      status: "pending",
    });

    const beforeConflict = await fetchBookingDeskSnapshot(fx.salonId, bookingAId);
    expect(beforeConflict).not.toBeNull();

    // Future day → the walk-in queue panel isn't rendered, so don't wait for it
    // (gotoReceptionistCenter's default would time out on walkin-add-form).
    await gotoReceptionistCenter(page, fx.slug, { dateYmd: dayYmd, expectWalkinQueue: false });
    await page.getByTestId(`booking-block-${bookingAId}`).click();
    await page.getByTestId("edit-booking-button").click();
    await expect(page.getByTestId("edit-booking-form")).toBeVisible();

    // Edit form opens on A's day (= dayYmd) by default. Wait for the grid.
    await expect(page.getByTestId("edit-time-grid")).toBeVisible({ timeout: 15_000 });

    // Prevention: the busy slot (B's 15:00 start) is NOT offered.
    const busyMinutes = salonMinutesUtc(busyHour, 0); /* 900 */
    await expect(page.getByTestId(`edit-time-slot-${busyMinutes}`)).toHaveCount(0);

    // Sanity: a known-free slot on the same day IS selectable, proving the grid
    // loaded with real availability (so the absence above is a real "blocked",
    // not an empty/unrendered grid). 09:00 is free for staffX.
    const freeMinutes = salonMinutesUtc(9, 0); /* 540 */
    await expect(page.getByTestId(`edit-time-slot-${freeMinutes}`)).toBeVisible();

    // Nothing was saved — A is unchanged.
    const after = await fetchBookingDeskSnapshot(fx.salonId, bookingAId);
    expect(after).toEqual(beforeConflict);
  });

  test("eb-5: Edit blocked for completed", async ({ page }) => {
    const taylorStaff = fx.staffIds[2]!;
    const polishId = fx.serviceIds[1]!;
    const marker = testClientNameMarker();

    const startIso = isoAtUtcYmdHourMinute(fx.ymdUtc, 17, 0);
    const endIso = endIsoFromDurationBuffer(startIso, 30, 10);
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: marker,
      serviceId: polishId,
      staffId: taylorStaff,
      startIso,
      endIso,
      status: "completed",
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc });
    await page.getByTestId(`booking-block-${bookingId}`).click();
    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();
    await expect(page.getByTestId("edit-booking-button")).toHaveCount(0);
  });
});
