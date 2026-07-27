import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
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

test.beforeAll(async ({}, testInfo) => {
  fixture = await seedFixture(fixtureSlug(testInfo.project.name));
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(fixtureSlug(testInfo.project.name));
});

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
    .locator('select:has(option:text-is("— Select a service —"))')
    .selectOption({ label: `${fixture.serviceName} · $35.00` });
  await page
    .locator(
      `select:has(option:text-is("${fixture.staffName}")):not([data-testid])`,
    )
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
