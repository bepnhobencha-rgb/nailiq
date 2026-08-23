import { expect, test, type Page } from "@playwright/test";

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

async function openCreateAppointment(page: Page): Promise<void> {
  const desktopControl = page.getByTestId("header-add-appointment");
  if (await desktopControl.isVisible()) {
    await desktopControl.click();
    return;
  }

  const mobileMenu = page.getByTestId("mobile-create-menu-trigger");
  await expect(mobileMenu).toBeVisible();
  await mobileMenu.click();
  await page.getByTestId("mobile-create-appointment").click();
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

test("operator completes the five essential Front Desk tasks in one shift", async ({
  page,
}) => {
  const appointmentName = testClientNameMarker();
  const walkinNames = Array.from({ length: 4 }, () => testClientNameMarker());
  const walkinName = walkinNames[0]!;
  const appointmentPhone = uniqueValidAppointmentPhone();
  const canonicalAppointmentPhone = `1${appointmentPhone}`;
  const bookingYmd = nextOpenYmd(fx.ymdUtc);
  const journeyStartedAt = Date.now();

  // A busy owner shift must surface online demand without sending anything.
  // Seed one waiting entry directly into the disposable salon and only assert
  // visibility; do not press Invite (which is the provider-backed boundary).
  const waitlistName = testClientNameMarker();
  const { data: waitlistRow, error: waitlistError } = await supabaseAdmin
    .from("booking_waitlist_entries" as never)
    .insert({
      salon_id: fx.salonId,
      service_id: fx.serviceIds[0]!,
      booking_date: fx.ymdUtc,
      client_name: waitlistName,
      client_phone: "16045552420",
      source: "slot_unavailable",
      status: "waiting",
    })
    .select("id")
    .single();
  if (waitlistError || !(waitlistRow as { id?: string } | null)?.id) {
    throw new Error(waitlistError?.message ?? "busy journey waitlist insert failed");
  }
  const waitlistId = (waitlistRow as unknown as { id: string }).id;

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
  await expect(page.getByTestId(`waitlist-entry-${waitlistId}`)).toContainText(
    waitlistName,
  );

  // 2. Create a scheduled appointment through the real desk form. A future
  // fixture day avoids wall-clock-dependent "past slot" filtering.
  await openCreateAppointment(page);
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
  await openCreateAppointment(page);
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

  // 4. Add four walk-ins during the same shift. The fourth moves the cockpit
  // into its explicit busy state, while every guest remains safely queued.
  for (const name of walkinNames) {
    await fillWalkinGuestContact(page, name);
    await clickWalkinService(page, fx.serviceIds[0]!);
    await clickWalkinSubmit(page);
    await expect(
      page.locator('[data-testid^="queue-item-"]').filter({ hasText: name }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("walkin-submit-label")).toBeVisible({
      timeout: 15_000,
    });
  }
  await expect(page.getByTestId("status-pill")).toHaveAttribute(
    "data-state",
    "busy",
  );
  await expect
    .poll(async () => {
      const row = await latestBooking(fx.salonId, walkinName);
      return row ? { source: row.source, status: row.status } : null;
    })
    .toEqual({ source: "walkin", status: "waiting" });

  // On mobile the walk-in queue is a full-screen slide-over and intentionally
  // stays open after adding a guest so the operator can continue intake. Close
  // it before the journey moves back to the schedule; otherwise a same-day
  // navigation can keep the overlay mounted and hide the appointment block.
  if ((page.viewportSize()?.width ?? 1280) < 640) {
    const queuePanel = page.getByTestId("walkin-queue-sidebar");
    await queuePanel.getByRole("button", { name: "Close" }).click();
    // The slide-over stays mounted for a smooth exit transition; its semantic
    // closed state is `aria-hidden=true` rather than DOM removal.
    await expect(page.getByTestId("queue-panel-slideover")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  }

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

  // A deterministic ceiling catches regressions that turn this compact busy
  // shift into a multi-minute operator task. This is an automated QA timing
  // budget, not a claim about a moderated human usability session.
  expect(Date.now() - journeyStartedAt).toBeLessThan(120_000);
});
