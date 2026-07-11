import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { DEFAULT_OPENING_HOURS_JSON } from "@/shared/dashboard/openingHoursDefaults";

import { seedDeskBooking, supabaseAdmin } from "./helpers";

// Run-scoped slug so parallel/local runs don't stomp each other.
const _RUN_SUFFIX =
  process.env.GITHUB_RUN_ID ??
  process.env.PLAYWRIGHT_WORKER_INDEX ??
  String(Date.now()).slice(-6);

const SLUG = `e2e-staff-deactivate-${_RUN_SUFFIX}`;
const NAME_BLOCK = "E2E_DEACT_BLOCK";
const NAME_OK = "E2E_DEACT_OK";

type Fixture = {
  salonId: string;
  slug: string;
  serviceId: string;
};

function tomorrowYmdUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function yesterdayYmdUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function isoAtUtcYmdHourMinute(
  ymd: string,
  hour: number,
  minute: number,
): string {
  const [y, m, dd] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd, hour, minute, 0)).toISOString();
}

async function gotoSetupStaff(page: Page, slug: string): Promise<void> {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  let hostname = "localhost";
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    /* noop */
  }

  await page.context().addCookies([
    {
      name: "nailiq-demo-slug",
      value: slug,
      domain:
        hostname === "127.0.0.1"
          ? "127.0.0.1"
          : hostname === "localhost"
            ? "localhost"
            : hostname,
      path: "/" as const,
    },
  ]);

  await page.goto(`/dashboard/${encodeURIComponent(slug)}/setup/staff`);
  await page
    .getByRole("heading", { name: "Staff", exact: false })
    .first()
    .waitFor({ timeout: 45_000 });
}

async function seedSalonAndService(): Promise<Fixture> {
  await cleanupTestSalon(SLUG);

  const openingParsed: unknown = JSON.parse(DEFAULT_OPENING_HOURS_JSON);

  const { data: salon, error: salonErr } = await supabaseAdmin
    .from("salons")
    .insert({
      slug: SLUG,
      name: "E2E Staff Deactivate Salon",
      phone: "15558887777",
      profile_complete: true,
      timezone: "UTC",
      opening_hours: openingParsed,
      setup_wizard_completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (salonErr || !salon?.id) {
    throw new Error(salonErr?.message ?? "seedSalon: salon insert failed");
  }
  const salonId = salon.id as string;

  // A second, always-present staff so the "minimum 1 staff" rule never
  // interferes and the panel always has more than one row.
  const { error: anchorErr } = await supabaseAdmin.from("staff").insert({
    salon_id: salonId,
    name: "E2E_DEACT_ANCHOR",
    job_role: "owner",
  });
  if (anchorErr) {
    await supabaseAdmin.from("salons").delete().eq("id", salonId);
    throw new Error(anchorErr.message);
  }

  const { data: svc, error: svcErr } = await supabaseAdmin
    .from("services")
    .insert({
      salon_id: salonId,
      name: "E2E_DEACT_Service",
      price_cents: 3000,
      duration_minutes: 30,
      buffer_minutes: 5,
    })
    .select("id")
    .single();

  if (svcErr || !svc?.id) {
    await supabaseAdmin.from("salons").delete().eq("id", salonId);
    throw new Error(svcErr?.message ?? "seedSalon: service insert failed");
  }

  return { salonId, slug: SLUG, serviceId: svc.id as string };
}

async function resetEphemeralStaffAndBookings(salonId: string): Promise<void> {
  await supabaseAdmin.from("bookings").delete().eq("salon_id", salonId);
  await supabaseAdmin
    .from("staff")
    .delete()
    .eq("salon_id", salonId)
    .in("name", [NAME_BLOCK, NAME_OK]);
}

async function insertStaff(salonId: string, name: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("staff")
    .insert({ salon_id: salonId, name, job_role: "nail_tech" })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(error?.message ?? "staff insert");
  return data.id as string;
}

async function getStaffStatus(staffId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("staff")
    .select("status")
    .eq("id", staffId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.status as string | undefined) ?? null;
}

/** Open the edit drawer for a staff row, then set the status <select>. */
async function openDrawerAndSetStatus(
  page: Page,
  staffId: string,
  status: "active" | "inactive",
): Promise<void> {
  await page.getByTestId(`staff-edit-${staffId}`).click();
  await page.getByTestId("staff-drawer-status").waitFor({ timeout: 10_000 });
  await page.getByTestId("staff-drawer-status").selectOption(status);
}

let fx: Fixture;

test.beforeAll(async () => {
  fx = await seedSalonAndService();
});

test.beforeEach(async () => {
  await resetEphemeralStaffAndBookings(fx.salonId);
});

test.afterAll(async () => {
  await cleanupTestSalon(SLUG);
});

test.describe("Setup staff deactivate guard", () => {
  test.describe.configure({ timeout: 60_000 });

  test("da-1: cannot deactivate staff with an upcoming appointment", async ({
    page,
  }) => {
    const blockId = await insertStaff(fx.salonId, NAME_BLOCK);
    const ymd = tomorrowYmdUtc();
    await seedDeskBooking(fx.salonId, {
      clientName: "E2E_DEACT_FUTURE",
      serviceId: fx.serviceId,
      staffId: blockId,
      startIso: isoAtUtcYmdHourMinute(ymd, 14, 0),
      endIso: isoAtUtcYmdHourMinute(ymd, 14, 45),
      status: "pending",
      source: "appointment",
    });

    await gotoSetupStaff(page, fx.slug);
    await openDrawerAndSetStatus(page, blockId, "inactive");

    await page.getByRole("button", { name: /^Save$/ }).click();

    // The guard rejects the deactivation → the drawer shows the reassign-first
    // field error and the drawer stays open.
    const fieldError = page.getByTestId("staff-drawer-field-error");
    await expect(fieldError).toBeVisible({ timeout: 15_000 });
    await expect(fieldError).toContainText(/upcoming appointments|Reassign/i);

    await page.screenshot({
      path: "playwright-report/deactivate-blocked-desktop.png",
      fullPage: true,
    });

    // Server-side truth: staff is NOT inactive.
    expect(await getStaffStatus(blockId)).not.toBe("inactive");
  });

  test("da-2: can deactivate staff with only past/completed history", async ({
    page,
  }) => {
    const okId = await insertStaff(fx.salonId, NAME_OK);
    const ymd = yesterdayYmdUtc();
    await seedDeskBooking(fx.salonId, {
      clientName: "E2E_DEACT_PAST",
      serviceId: fx.serviceId,
      staffId: okId,
      startIso: isoAtUtcYmdHourMinute(ymd, 11, 0),
      endIso: isoAtUtcYmdHourMinute(ymd, 11, 45),
      status: "completed",
      source: "appointment",
    });

    await gotoSetupStaff(page, fx.slug);
    await openDrawerAndSetStatus(page, okId, "inactive");

    await page.getByRole("button", { name: /^Save$/ }).click();

    // No field error; deactivation lands in the DB.
    await expect
      .poll(async () => getStaffStatus(okId), { timeout: 15_000 })
      .toBe("inactive");
  });
});
