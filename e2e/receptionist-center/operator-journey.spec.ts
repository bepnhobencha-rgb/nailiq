import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  clickWalkinService,
  clickWalkinSubmit,
  fillReactInput,
  fillWalkinGuestContact,
  getBookingRow,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  supabaseAdmin,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

type JourneyBooking = {
  id: string;
  client_name: string;
  client_phone: string | null;
  source: string;
  status: string;
  start_time_utc: string | null;
};

function uniqueValidAppointmentPhone(): string {
  // Keep a known-valid NANP prefix while avoiding collisions with customers
  // created by other Receptionist Center specs in the shared fixture salon.
  const lineNumber = 2_000 + (Date.now() % 8_000);
  return `604555${String(lineNumber).padStart(4, "0")}`;
}

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

async function latestBooking(
  salonId: string,
  clientName: string,
): Promise<JourneyBooking | null> {
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("id,client_name,client_phone,source,status,start_time_utc")
    .eq("salon_id", salonId)
    .eq("client_name", clientName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as JourneyBooking | null;
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

test("operator completes the five essential Front Desk tasks in one shift", async ({
  page,
}) => {
  const appointmentName = testClientNameMarker();
  const walkinName = testClientNameMarker();
  const appointmentPhone = uniqueValidAppointmentPhone();
  const canonicalAppointmentPhone = `1${appointmentPhone}`;
  const bookingYmd = nextOpenYmd(fx.ymdUtc);

  // 1. View today: the board opens on the salon's current day, with the
  // Today tab selected and the live walk-in intake present.
  await gotoReceptionistCenter(page, fx.slug);
  await expect(page.getByTestId("date-switcher-today")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const todayBox = await page.getByTestId("date-switcher-today").boundingBox();
  expect(todayBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("walkin-add-form")).toBeVisible();

  // 2. Create a scheduled appointment through the real desk form. A future
  // fixture day avoids wall-clock-dependent "past slot" filtering.
  await page.getByTestId("header-add-appointment").click();
  await expect(page.getByTestId("desk-booking-form")).toBeVisible();
  await fillReactInput(page.getByTestId("desk-client-phone"), appointmentPhone);
  await fillReactInput(page.getByTestId("desk-client-name"), appointmentName);
  await page.getByTestId("desk-service-select").selectOption(fx.serviceIds[0]!);
  await page.getByTestId("desk-staff-select").selectOption(fx.freeStaffId);
  await page.getByTestId("desk-date-input").fill(bookingYmd);
  const firstSlot = page.getByTestId("desk-time-slot").first();
  await expect(firstSlot).toBeVisible({ timeout: 15_000 });
  await firstSlot.click();

  const smsToggle = page.getByTestId("notify-toggle-sms");
  if ((await smsToggle.getAttribute("aria-checked")) === "true") {
    await smsToggle.click();
  }
  await expect(page.getByTestId("notify-none")).toBeVisible();
  await page.getByTestId("desk-booking-submit").click();
  await expect(page.getByTestId("desk-booking-form")).toHaveCount(0, {
    timeout: 15_000,
  });

  let appointment: JourneyBooking | null = null;
  await expect
    .poll(async () => {
      appointment = await latestBooking(fx.salonId, appointmentName);
      return appointment
        ? {
            source: appointment.source,
            status: appointment.status,
            phone: appointment.client_phone,
            ymd: appointment.start_time_utc?.slice(0, 10),
          }
        : null;
    })
    .toEqual({
      source: "appointment",
      status: "confirmed",
      phone: canonicalAppointmentPhone,
      ymd: bookingYmd,
    });

  // 3. Find the customer from the same Front Desk form. The hit must be scoped
  // to this salon and selecting it must restore the known phone.
  await page.getByTestId("header-add-appointment").click();
  await fillReactInput(page.getByTestId("desk-client-name"), appointmentName);
  const searchHit = page
    .getByTestId("desk-client-search-hit")
    .filter({ hasText: appointmentName });
  await expect(searchHit).toBeVisible({ timeout: 15_000 });
  await searchHit.click();
  await expect(page.getByTestId("desk-client-phone")).toHaveValue(
    canonicalAppointmentPhone,
  );
  await page
    .getByTestId("desk-booking-form")
    .getByRole("button", { name: "Close" })
    .click();

  // 4. Add a walk-in and prove a waiting queue row was persisted.
  await fillWalkinGuestContact(page, walkinName);
  await clickWalkinService(page, fx.serviceIds[0]!);
  await clickWalkinSubmit(page);
  await expect(
    page.locator('[data-testid^="queue-item-"]').filter({ hasText: walkinName }),
  ).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => {
      const row = await latestBooking(fx.salonId, walkinName);
      return row ? { source: row.source, status: row.status } : null;
    })
    .toEqual({ source: "walkin", status: "waiting" });

  // 5. Change appointment status and prove the UI action reached the database.
  const persistedAppointment = await latestBooking(fx.salonId, appointmentName);
  if (!persistedAppointment) throw new Error("Appointment was not persisted");
  await gotoReceptionistCenter(page, fx.slug, {
    dateYmd: bookingYmd,
    expectWalkinQueue: false,
  });
  await page
    .getByTestId(`booking-block-${persistedAppointment.id}`)
    .click();
  await expect(page.getByTestId("drawer-primary-action")).toBeVisible();
  await page.getByTestId("drawer-primary-action").click();
  await expect
    .poll(
      async () =>
        (await getBookingRow(fx.salonId, persistedAppointment.id))?.status,
      { timeout: 15_000 },
    )
    .toBe("in_progress");
});
