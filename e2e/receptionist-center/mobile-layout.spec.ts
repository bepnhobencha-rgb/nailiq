import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  clickWalkinService,
  clickWalkinSubmit,
  fillReactInput,
  fillWalkinGuestContact,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  supabaseAdmin,
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

/**
 * Case 7 (automated slice): viewport ≤768px stacks queue above timeline (`order-1` / `order-2`).
 * Real iPad Safari behavior remains manual (see deliverables).
 */
test.describe("Mobile layout", () => {
  function nextOpenYmd(ymd: string): string {
    const [year, month, day] = ymd.split("-").map(Number);
    const start = Date.UTC(year, month - 1, day);
    for (let offset = 1; offset <= 7; offset += 1) {
      const candidate = new Date(start + offset * 86_400_000);
      if (candidate.getUTCDay() !== 0) {
        return candidate.toISOString().slice(0, 10);
      }
    }
    throw new Error("No open fixture day found");
  }

  async function expectPrimaryControlSize(
    locator: import("@playwright/test").Locator,
  ) {
    await expect(locator).toBeVisible();
    const metrics = await locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      };
    });

    expect(metrics.width).toBeGreaterThanOrEqual(44);
    expect(metrics.height).toBeGreaterThanOrEqual(44);
    expect(metrics.fontSize).toBeGreaterThanOrEqual(16);
  }

  async function expectReadableScheduleText(
    locator: import("@playwright/test").Locator,
  ) {
    await expect(locator).toBeVisible();
    const fontSize = await locator.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    expect(fontSize).toBeGreaterThanOrEqual(16);
  }

  test("daily brief keeps the schedule primary until details are requested", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, fx.slug);

    const summary = page.getByTestId("nailiq-daily-brief-summary");
    await expect(summary).toBeVisible();
    await expect(page.getByTestId("nailiq-daily-brief")).toHaveCount(0);

    await summary.click();
    await expect(page.getByTestId("nailiq-daily-brief")).toBeVisible();

    await page.getByTestId("nailiq-daily-brief-collapse").click();
    await expect(summary).toBeVisible();
  });

  test("case 7: narrow viewport places walk-in form above timeline", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, fx.slug);

    const form = page.getByTestId("walkin-add-form");
    const grid = page.getByTestId("vertical-day-view");

    await expect(form).toBeVisible();
    await expect(grid).toBeVisible();

    const formBox = await form.boundingBox();
    const gridBox = await grid.boundingBox();
    expect(formBox && gridBox).toBeTruthy();
    if (!formBox || !gridBox) return;

    expect(formBox.y).toBeLessThan(gridBox.y);
  });

  test("primary Front Desk actions meet 44px touch and 16px text contracts", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, fx.slug);

    await expectPrimaryControlSize(page.getByTestId("header-add-walkin"));
    await expectPrimaryControlSize(page.getByTestId("walkin-submit"));
    await expectPrimaryControlSize(page.getByTestId("walkin-details-toggle"));

    // Classic mobile previously hid this CTA below the `sm` breakpoint,
    // leaving phone users no direct way to create a scheduled appointment.
    const newAppointment = page.getByTestId("header-add-appointment");
    await expectPrimaryControlSize(newAppointment);
    await newAppointment.click();

    const phoneInput = page.locator('input[inputmode="tel"]');
    await expectPrimaryControlSize(phoneInput);
    await expectPrimaryControlSize(
      page.getByRole("button", { name: /close|đóng/i }),
    );
    await expectPrimaryControlSize(
      page.getByRole("button", {
        name: /create appointment|tạo lịch hẹn/i,
      }),
    );
  });

  test("receptionist adds a persisted walk-in on iPhone in under 60 seconds", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, fx.slug);

    const clientName = testClientNameMarker();
    const startedAt = Date.now();

    // Advanced queue metadata stays out of the default speed path.
    await expect(page.getByTestId("walkin-optional-details")).toHaveCount(0);
    await fillWalkinGuestContact(page, clientName);
    await clickWalkinService(page, fx.serviceIds[0]!);
    await clickWalkinSubmit(page);

    await expect
      .poll(async () => {
        const { data, error } = await supabaseAdmin
          .from("bookings")
          .select("source,status")
          .eq("salon_id", fx.salonId)
          .eq("client_name", clientName)
          .maybeSingle();
        if (error) throw new Error(error.message);
        return data;
      })
      .toEqual({ source: "walkin", status: "waiting" });

    expect(Date.now() - startedAt).toBeLessThan(60_000);
  });

  test("walk-in operational details remain available on demand", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, fx.slug);

    const toggle = page.getByTestId("walkin-details-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("walkin-optional-details")).toBeVisible();
    await expectPrimaryControlSize(page.getByTestId("walkin-source"));
    await expectPrimaryControlSize(page.getByTestId("walkin-priority"));
    await expectPrimaryControlSize(
      page.getByTestId("walkin-request-tag-input"),
    );
  });

  test("receptionist creates a persisted appointment on iPhone in under 60 seconds", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, fx.slug);

    const clientName = testClientNameMarker();
    const clientPhone = `604555${String(2_000 + (Date.now() % 8_000)).padStart(4, "0")}`;
    const bookingYmd = nextOpenYmd(fx.ymdUtc);
    const startedAt = Date.now();

    await page.getByTestId("header-add-appointment").click();
    const form = page.getByTestId("desk-booking-form");
    await expect(form).toBeVisible();
    await fillReactInput(page.getByTestId("desk-client-phone"), clientPhone);
    await fillReactInput(page.getByTestId("desk-client-name"), clientName);
    await page
      .getByTestId("desk-service-select")
      .selectOption(fx.serviceIds[0]!);
    await page.getByTestId("desk-staff-select").selectOption(fx.freeStaffId);
    await page.getByTestId("desk-date-input").fill(bookingYmd);

    const firstSlot = page.getByTestId("desk-time-slot").first();
    await expect(firstSlot).toBeVisible({ timeout: 15_000 });
    await firstSlot.click();

    // E2E proves booking persistence without sending a real customer message.
    const smsToggle = page.getByTestId("notify-toggle-sms");
    if ((await smsToggle.getAttribute("aria-checked")) === "true") {
      await smsToggle.click();
    }
    await page.getByTestId("desk-booking-submit").click();
    await expect(form).toHaveCount(0, { timeout: 15_000 });

    await expect
      .poll(async () => {
        const { data, error } = await supabaseAdmin
          .from("bookings")
          .select("source,status")
          .eq("salon_id", fx.salonId)
          .eq("client_name", clientName)
          .maybeSingle();
        if (error) throw new Error(error.message);
        return data;
      })
      .toEqual({ source: "appointment", status: "confirmed" });

    expect(Date.now() - startedAt).toBeLessThan(60_000);
  });

  test("today schedule keeps operational details readable and touchable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, fx.slug);

    const booking = page.getByTestId(
      `booking-block-${fx.displayApptBookingId}`,
    );
    await expect(booking).toBeVisible();
    const bookingButton = booking.locator(":scope > button");
    await expect(bookingButton).toHaveCount(1);
    const bookingBox = await bookingButton.boundingBox();
    expect(bookingBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await expectReadableScheduleText(
      page.getByTestId(`booking-block-client-${fx.displayApptBookingId}`),
    );
    await expectReadableScheduleText(
      page.getByTestId(`booking-block-service-${fx.displayApptBookingId}`),
    );
    await expectReadableScheduleText(
      page.getByTestId(`booking-block-time-${fx.displayApptBookingId}`),
    );
    await expectReadableScheduleText(
      page.getByTestId(`booking-block-staff-${fx.displayApptBookingId}`),
    );

    for (const label of ["Prev day", "Next day"]) {
      const control = page.getByRole("button", { name: label, exact: true });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const emptySlots = page.locator('[data-testid^="mobile-empty-slot-"]');
    expect(await emptySlots.count()).toBeGreaterThan(0);
    const emptySlot = emptySlots.first();
    const emptySlotBox = await emptySlot.boundingBox();
    expect(emptySlotBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
