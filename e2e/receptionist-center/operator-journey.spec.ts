import { expect, test, type Page } from "@playwright/test";

import { cleanupTestSalon, cleanupTestUser, seedTestSalonMember } from "../helpers/db";
import { waitForReceptionistHydration } from "../helpers/receptionistHydration";
import {
  cleanReceptionistData,
  clickWalkinService,
  clickWalkinSubmit,
  fillReactInput,
  fillWalkinGuestContact,
  getBookingRow,
  gotoReceptionistCenter as openReceptionistCenter,
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
let receptionist: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;

async function gotoReceptionistCenter(
  page: Page,
  slug: string,
  options?: Parameters<typeof openReceptionistCenter>[2],
): Promise<void> {
  await openReceptionistCenter(page, slug, { ...options, useDemoCookie: false });
}

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

async function closeQueuePanelIfOpen(page: Page): Promise<void> {
  const panel = page.getByTestId("queue-panel-slideover");
  // The queue is a today-only surface. Future appointment dates do not mount
  // it, so absence is already the desired state.
  if ((await panel.count()) === 0) return;
  if ((await panel.getAttribute("aria-hidden")) !== "false") return;

  await page
    .getByTestId("walkin-queue-sidebar")
    .getByRole("button", { name: /close|đóng/i })
    .click();
  await expect(panel).toHaveAttribute("aria-hidden", "true");
}

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
  receptionist = await seedTestSalonMember(fx.salonId, "receptionist");
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async ({}, testInfo) => {
  try {
    if (receptionist) await cleanupTestUser(receptionist.userId);
  } finally {
    await cleanupTestSalon(rcSlug(testInfo.project.name));
  }
});

test("operator completes the five essential Front Desk tasks in one shift", async ({
  page, context,
}, testInfo) => {
  // This journey never needs an external browser request, including providers.
  const appOrigin = new URL(String(testInfo.project.use.baseURL)).origin;
  const apiOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;
  const pageErrors: string[] = [];
  const appServerFailures: number[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (new URL(response.url()).origin === appOrigin && response.status() >= 500) appServerFailures.push(response.status());
  });
  await context.route("**/*", (route) => {
    const origin = new URL(route.request().url()).origin;
    return origin === appOrigin || origin === apiOrigin
      ? route.continue()
      : route.abort();
  });
  const language = testInfo.project.name.endsWith("-vi") ? "vi" : "en";
  // Regression: a confirmed appointment 45 minutes away must not inflate
  // the "Coming up (30m)" tile or the action-card recommendation.
  const farStart = Date.now() + 45 * 60_000;
  const farBooking = await supabaseAdmin.from("bookings").insert({
    salon_id: fx.salonId, service_id: fx.serviceIds[4], staff_id: fx.freeStaffId,
    client_name: testClientNameMarker(), client_phone: null,
    start_time_utc: new Date(farStart).toISOString(),
    end_time_utc: new Date(farStart + 25 * 60_000).toISOString(),
    status: "confirmed", source: "appointment", price_cents: 1500,
  });
  expect(farBooking.error?.code ?? null).toBeNull();
  await page.addInitScript(({ language, appOrigin }) => {
    // Runs on every navigation. Never access storage outside the app origin.
    if (window.location.origin === appOrigin) window.localStorage.setItem("nailiq-user-lang", language);
  }, { language, appOrigin });

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
      staff_id: fx.conflictStaffId,
      booking_date: fx.ymdUtc,
      preferred_slot_label: fx.conflictSlotLabel,
      client_name: waitlistName,
      client_phone: "16045552420",
      // The requested technician is already occupied at this exact local
      // time, so the authoritative capacity guard proves the request is full.
      source: "slot_unavailable",
      intent_json: {
        source: "slot_unavailable",
        staffPreference: fx.conflictStaffId,
      },
      status: "waiting",
    })
    .select("id")
    .single();
  if (waitlistError || !(waitlistRow as { id?: string } | null)?.id) {
    throw new Error(waitlistError?.message ?? "busy journey waitlist insert failed");
  }
  const waitlistId = (waitlistRow as unknown as { id: string }).id;

  // Seed before real sign-in so the initial board contains the full fixture.
  // Do not hard-reload the landing page while its shell is still starting.
  if (!receptionist) throw new Error("Receptionist fixture missing");
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute("data-hydrated", "true");
  await page.locator('input[inputmode="email"]').fill(receptionist.email);
  await page.locator('input[type="password"]').fill(receptionist.password);
  await page.getByTestId("password-signin-submit").click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
  const centerPath = `/dashboard/${encodeURIComponent(fx.slug)}/center`;
  if (new URL(page.url()).pathname !== centerPath) {
    await page.locator(`a[href="${centerPath}?view=day"]:visible`).first().click();
  }
  await expect(page).toHaveURL(new RegExp(`${centerPath}(?:\\?.*)?$`));
  await waitForReceptionistHydration(page, fx.slug);
  const initialBoard = page.getByTestId((page.viewportSize()?.width ?? 1280) < 640 ? "vertical-day-view" : "staff-timeline-grid");
  // SPA transition can briefly retain the previous board while the destination
  // commits. Assert uniqueness before using strict single-element locators.
  await expect(initialBoard).toHaveCount(1);
  await expect(initialBoard).toBeVisible();
  expect((await page.context().cookies()).some((cookie) => cookie.name === "nailiq-demo-slug")).toBe(false);

  // 1. View today: the board opens on the salon's current day, with the
  // Today tab selected and the live walk-in intake present.
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
  const snapshotNow = Date.now();
  const upcomingRows = await supabaseAdmin.from("bookings")
    .select("id").eq("salon_id", fx.salonId).in("status", ["pending", "confirmed"])
    .gt("start_time_utc", new Date(snapshotNow).toISOString())
    .lte("start_time_utc", new Date(snapshotNow + 30 * 60_000).toISOString());
  expect(upcomingRows.error?.code ?? null).toBeNull();
  await expect(page.getByTestId("kpi-tile-coming-up")).toHaveText(
    new RegExp(`${language === "vi" ? "Sắp tới \\(30p\\)" : "Coming up \\(30m\\)"}\\s*${upcomingRows.data!.length}$`),
  );

  // Real PostgREST regression: explicit in-progress truth wins over the
  // four-hour forecast horizon. Never suggest that technician as free.
  const activeStart = Date.now() + 5 * 60 * 60_000;
  const activeUpdate = await supabaseAdmin.from("bookings").update({
    start_time_utc: new Date(activeStart).toISOString(),
    end_time_utc: new Date(activeStart + 55 * 60_000).toISOString(),
  }).eq("salon_id", fx.salonId).eq("client_name", "RC Baseline In Progress");
  expect(activeUpdate.error?.code ?? null).toBeNull();
  await clickWalkinService(page, fx.serviceIds[0]!);
  await expect(page.locator(`#walkin-service-${fx.serviceIds[0]}`)).toContainText(language === "vi" ? "45 phút" : "45m");
  await page.getByTestId("walkin-requested-staff").selectOption(fx.staffIds[4]!);
  await expect(page.getByTestId("walkin-availability-card")).toHaveAttribute("data-walkin-availability-state", /^(busy|heavy)$/);
  await expect(page.getByTestId("walkin-availability-card")).toContainText(language === "vi"
    ? "Đang bận — chưa xác định giờ rảnh" : "Busy — ready time not yet confirmed");
  await page.getByTestId("walkin-requested-staff").selectOption("");
  await closeQueuePanelIfOpen(page);

  // 2. Create a scheduled appointment through the real desk form. A future
  // fixture day avoids wall-clock-dependent "past slot" filtering.
  await openCreateAppointment(page);
  const form = page.getByTestId("desk-booking-form");
  await expect(form).toBeVisible();
  await expect(form).toBeFocused();
  const labelNames = language === "vi"
    ? [/^Số điện thoại/, /^Tên khách/, /^Email/, /^Dịch vụ \*/, /^Thợ \*/, /^Ngày \*/, /^Ghi chú/]
    : [/^Phone number/, /^Customer name/, /^Email/, /^Service \*/, /^Staff \*/, /^Date \*/, /^Notes/];
  for (const label of labelNames) await expect(form.getByLabel(label)).toBeVisible();
  const closeForm = form.getByRole("button", { name: /^(Close|Đóng)$/ });
  await closeForm.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(form.getByLabel(labelNames[6]!)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeForm).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  const returnTarget = page.getByTestId("header-add-appointment");
  await expect(await returnTarget.isVisible() ? returnTarget : page.getByTestId("mobile-create-menu-trigger")).toBeFocused();
  await openCreateAppointment(page);
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
  // Existing-client selection must also work without a mouse.
  await page.getByTestId("desk-client-name").focus();
  // Safari's default Tab behavior skips buttons; arrows also support an
  // external keyboard on the mobile/tablet layout without OS preference changes.
  await page.keyboard.press(testInfo.project.name.startsWith("desktop") ? "Tab" : "ArrowDown");
  // Deliberately exceed the former 150ms blur-dismiss timer: a person must
  // have time to read the matching identity before pressing Enter.
  await page.waitForTimeout(350);
  await expect(searchHit).toBeVisible();
  await expect(searchHit).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("desk-client-email")).toBeFocused();
  await expect(page.getByTestId("desk-client-phone")).toHaveValue(
    canonicalAppointmentPhone,
  );
  await page
    .getByTestId("desk-booking-form")
    .getByRole("button", { name: /close|đóng/i })
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

  // The walk-in queue intentionally stays open after adding a guest so the
  // operator can continue intake. Close the panel before the journey moves
  // back to the schedule; at tablet widths it can otherwise cover the booking
  // column that the next task needs.
  await closeQueuePanelIfOpen(page);

  // 5. Change appointment status and prove the UI action reached the database.
  const persistedAppointment = await latestBooking(fx.salonId, appointmentName);
  if (!persistedAppointment) throw new Error("Appointment was not persisted");
  // Use the operator's date control rather than about:blank: an opaque-origin
  // transition races WebKit's pending same-origin requests and emits false
  // access-control page errors. Sunday fallback stays on the app origin.
  if (Date.parse(`${bookingYmd}T00:00:00Z`) - Date.parse(`${fx.ymdUtc}T00:00:00Z`) === 86_400_000) {
    await page.getByTestId("date-switcher-tomorrow").click();
  } else {
    await page.goto("/terms");
    await gotoReceptionistCenter(page, fx.slug, { dateYmd: bookingYmd, expectWalkinQueue: false });
  }
  await expect(page).toHaveURL(new RegExp(`[?&]date=${bookingYmd}(?:&|$)`));
  // A fresh page session intentionally auto-opens a non-empty queue. Dismiss
  // it again so the operator can work with the appointment underneath.
  await closeQueuePanelIfOpen(page);
  await page
    .getByTestId(`booking-block-${persistedAppointment.id}`)
    .click();
  const details = page.getByTestId("booking-detail-drawer");
  await expect(details).toBeFocused();
  await page.keyboard.press("Escape");
  const bookingTrigger = page.getByTestId(`booking-block-${persistedAppointment.id}`);
  // The compact mobile card has a dedicated inner button.
  await expect.poll(() => bookingTrigger.evaluate((element) => element === document.activeElement || element.contains(document.activeElement))).toBe(true);
  await bookingTrigger.click();
  await expect(page.getByTestId("drawer-primary-action")).toBeVisible();
  await page.getByTestId("drawer-primary-action").click();
  await expect
    .poll(
      async () =>
        (await getBookingRow(fx.salonId, persistedAppointment.id))?.status,
      { timeout: 15_000 },
    )
    .toBe("in_progress");
  // The status mutation refreshes Router data. Its canonical URL must retain
  // the selected day rather than silently returning to the initial /center.
  await expect(page).toHaveURL(new RegExp(`[?&]date=${bookingYmd}(?:&|$)`));
  await expect(page.getByTestId(`booking-block-${persistedAppointment.id}`)).toBeVisible();

  // A deterministic ceiling catches regressions that turn this compact busy
  // shift into a multi-minute operator task. This is an automated QA timing
  // budget, not a claim about a moderated human usability session.
  expect(Date.now() - journeyStartedAt).toBeLessThan(120_000);
  expect(pageErrors).toEqual([]);
  expect(appServerFailures).toEqual([]);

  await testInfo.attach("p1-03-final-state", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});
