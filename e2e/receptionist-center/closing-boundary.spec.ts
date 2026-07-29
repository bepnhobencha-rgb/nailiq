import { expect, test } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestUser,
} from "../helpers/db";
import { waitForReceptionistHydration } from "../helpers/receptionistHydration";
import {
  fillReactInput,
  gotoReceptionistCenter,
  supabaseAdmin,
} from "./helpers";

const RUN_SUFFIX =
  process.env.GITHUB_RUN_ID ??
  process.env.PLAYWRIGHT_WORKER_INDEX ??
  String(Date.now()).slice(-6);

function fixtureSlug(project: string): string {
  return `${project === "mobile" ? "e2e-close-mob" : "e2e-close-dsk"}-${RUN_SUFFIX}`;
}

type Fixture = {
  salonId: string;
  slug: string;
  serviceName: string;
  staffName: string;
  dateYmd: string;
};

async function seedFixture(slug: string): Promise<Fixture> {
  await cleanupTestSalon(slug);
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const dateYmd = tomorrow.toISOString().slice(0, 10);
  const hours = Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
      day,
      { open: "09:00", close: "19:30", closed: false },
    ]),
  );

  const { data: salon, error: salonError } = await supabaseAdmin
    .from("salons")
    .insert({
      slug,
      name: "E2E Closing Boundary Head Spa",
      phone: "15550190000",
      profile_complete: true,
      timezone: "UTC",
      address: "1 Closing Boundary Way",
      opening_hours: hours,
      booking_lead_minutes: 0,
      setup_wizard_completed_at: new Date().toISOString(),
      dashboard_preset: "rush_hour",
      walkin_auto_assign: false,
    } as never)
    .select("id")
    .single();
  if (salonError || !salon?.id) {
    throw new Error(salonError?.message ?? "closing fixture salon failed");
  }
  const salonId = String(salon.id);

  const serviceName = "E2E Express Head Spa";
  const { data: service, error: serviceError } = await supabaseAdmin
    .from("services")
    .insert({
      salon_id: salonId,
      name: serviceName,
      duration_minutes: 30,
      buffer_minutes: 10,
      price_cents: 3500,
    })
    .select("id")
    .single();
  if (serviceError || !service?.id) {
    throw new Error(serviceError?.message ?? "closing fixture service failed");
  }

  const staffName = "Anna";
  const { data: staff, error: staffError } = await supabaseAdmin
    .from("staff")
    .insert({
      salon_id: salonId,
      name: staffName,
      job_role: "nail_tech",
      status: "active",
    })
    .select("id")
    .single();
  if (staffError || !staff?.id) {
    throw new Error(staffError?.message ?? "closing fixture staff failed");
  }

  const { error: capabilityError } = await supabaseAdmin
    .from("staff_services")
    .insert({
      staff_id: staff.id,
      service_id: service.id,
    });
  if (capabilityError) throw new Error(capabilityError.message);

  return { salonId, slug, serviceName, staffName, dateYmd };
}

let fixture: Fixture;
let owner: Awaited<ReturnType<typeof seedTestUser>>;

test.beforeAll(async ({}, testInfo) => {
  fixture = await seedFixture(fixtureSlug(testInfo.project.name));
  owner = await seedTestUser();
  const { error } = await supabaseAdmin.from("salon_members").insert({
    salon_id: fixture.salonId,
    user_id: owner.userId,
    role: "owner",
  });
  if (error) throw new Error(`closing fixture owner: ${error.message}`);
});

test.beforeEach(async () => {
  const { error } = await supabaseAdmin
    .from("bookings")
    .delete()
    .eq("salon_id", fixture.salonId);
  if (error) {
    throw new Error(`closing fixture booking reset: ${error.message}`);
  }
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(fixtureSlug(testInfo.project.name));
  if (owner?.userId) await cleanupTestUser(owner.userId);
});

async function loginOwner(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/register");
  await page.getByTestId("social-auth-controls").waitFor({ state: "attached" });
  await page.locator('input[inputmode="email"]').fill(owner.email);
  await page.locator('input[type="password"]').fill(owner.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
  await page.goto(
    `/dashboard/${encodeURIComponent(fixture.slug)}/center?date=${fixture.dateYmd}`,
  );
  await page
    .getByTestId("receptionist-center-loaded")
    .first()
    .waitFor({ state: "attached", timeout: 45_000 });
  await waitForReceptionistHydration(page, fixture.slug);
}

test("grid hides click-to-create preview when no service can finish before close", async ({
  page,
  isMobile,
}) => {
  test.skip(
    isMobile,
    "The click-to-create hover affordance is a desktop mouse interaction.",
  );

  await gotoReceptionistCenter(page, fixture.slug, {
    dateYmd: fixture.dateYmd,
    expectWalkinQueue: false,
  });

  const sevenPmSlot = page.locator(
    `[data-testid^="assign-slot-"][data-slot-utc="${fixture.dateYmd}T19:00:00.000Z"]`,
  );
  await sevenPmSlot.scrollIntoViewIfNeeded();
  const box = await sevenPmSlot.boundingBox();
  if (!box) throw new Error("7:00 PM grid slot has no bounding box");

  // The first half of the 30-minute cell is 7:00 PM. A 30-minute service can
  // finish exactly at 7:30 PM, so the preview remains truthful.
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await expect(page.getByTestId("create-booking-preview")).toContainText(
    "7:00 PM",
  );

  // The second half is 7:15 PM. No main service can finish before close, so
  // there must be no "+" affordance and clicking must not open the form.
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect(page.getByTestId("create-booking-preview")).toHaveCount(0);
  await expect(sevenPmSlot.locator("xpath=../..")).toHaveCSS(
    "cursor",
    "not-allowed",
  );
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect(
    page.locator('button:has-text("Create appointment")'),
  ).toHaveCount(0);
});

test("manual desk booking allows service to finish exactly at close and preserves buffer", async ({
  page,
}) => {
  const clientName = `Te2eGuestClosing${Date.now()}`;
  await gotoReceptionistCenter(page, fixture.slug, {
    dateYmd: fixture.dateYmd,
    expectWalkinQueue: false,
  });

  await page
    .getByTestId("header-add-appointment")
    .evaluate((element: HTMLElement) => element.click());
  await page
    .locator('button:has-text("Create appointment")')
    .waitFor({ state: "attached", timeout: 15_000 });

  await fillReactInput(page.locator('input[inputmode="tel"]'), "+17145550100");
  await fillReactInput(
    page.locator('input[autocomplete="off"]').first(),
    clientName,
  );
  await page
    .getByTestId("desk-service-select")
    .selectOption({ label: `${fixture.serviceName} · $35.00` });
  await page
    .getByTestId("desk-staff-select")
    .selectOption({ label: fixture.staffName });

  const sevenPm = page
    .locator("button")
    .filter({ hasText: /^7:00 PM$/ });
  await expect(sevenPm).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator("button").filter({ hasText: /^7:15 PM$/ }),
  ).toHaveCount(0);

  await sevenPm.evaluate((element: HTMLElement) => element.click());
  await page
    .locator('button:has-text("Create appointment")')
    .evaluate((element: HTMLElement) => element.click());

  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from("bookings")
          .select("start_time_utc, end_time_utc")
          .eq("salon_id", fixture.salonId)
          .eq("client_name", clientName)
          .maybeSingle();
        return data
          ? {
              start: new Date(String(data.start_time_utc)).toISOString(),
              end: new Date(String(data.end_time_utc)).toISOString(),
            }
          : null;
      },
      { timeout: 15_000 },
    )
    .toEqual({
      start: `${fixture.dateYmd}T19:00:00.000Z`,
      // Full occupied block remains 40 minutes; only closing eligibility uses
      // the 30-minute customer-facing service completion.
      end: `${fixture.dateYmd}T19:40:00.000Z`,
    });
});

test("Owner can explicitly approve a staff-consented after-hours booking", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "The mobile header intentionally hides New appointment.");
  const clientName = `Te2eAfterHours${Date.now()}`;
  await loginOwner(page);
  await page.getByTestId("header-add-appointment").click();
  await page
    .locator('button:has-text("Create appointment")')
    .waitFor({ state: "attached", timeout: 15_000 });

  await fillReactInput(page.locator('input[inputmode="tel"]'), "+17145550101");
  await fillReactInput(
    page.locator('input[autocomplete="off"]').first(),
    clientName,
  );
  await page
    .getByTestId("desk-service-select")
    .selectOption({ label: `${fixture.serviceName} · $35.00` });
  await page
    .getByTestId("desk-staff-select")
    .selectOption({ label: fixture.staffName });

  await expect(page.getByTestId("desk-after-hours-panel")).toBeVisible();
  await page.getByTestId("desk-after-hours-toggle").click();
  const sevenFifteen = page
    .getByTestId("desk-after-hours-slots")
    .getByRole("button", { name: /7:15 PM/ });
  await expect(sevenFifteen).toBeVisible({ timeout: 15_000 });
  await sevenFifteen.click();

  const submit = page.getByRole("button", {
    name: /Accept after-hours booking/i,
  });
  await expect(submit).toBeDisabled();
  await page.getByTestId("desk-after-hours-consent").check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from("bookings")
          .select(
            "id, start_time_utc, end_time_utc, after_hours_minutes, after_hours_approved_by, after_hours_staff_consent, booking_channel",
          )
          .eq("salon_id", fixture.salonId)
          .eq("client_name", clientName)
          .maybeSingle();
        if (!data) return null;
        const row = data as unknown as {
          start_time_utc: string;
          end_time_utc: string;
          after_hours_minutes: number;
          after_hours_approved_by: string;
          after_hours_staff_consent: boolean;
          booking_channel: string;
        };
        return {
          ...row,
          start_time_utc: new Date(row.start_time_utc).toISOString(),
          end_time_utc: new Date(row.end_time_utc).toISOString(),
        };
      },
      { timeout: 15_000 },
    )
    .toMatchObject({
      start_time_utc: `${fixture.dateYmd}T19:15:00.000Z`,
      end_time_utc: `${fixture.dateYmd}T19:55:00.000Z`,
      after_hours_minutes: 15,
      after_hours_approved_by: owner.userId,
      after_hours_staff_consent: true,
      booking_channel: "desk",
    });
  await expect(
    page.locator('[data-testid^="booking-block-icon-after-hours-"]').first(),
  ).toBeVisible({ timeout: 15_000 });
});
