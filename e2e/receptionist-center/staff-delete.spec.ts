import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { DEFAULT_OPENING_HOURS_JSON } from "@/shared/dashboard/openingHoursDefaults";

import { seedDeskBooking, supabaseAdmin } from "./helpers";

/** Stable slug; torn down in afterAll. Row scoping: `li:has(input[value="${name}"])` (matches Task 3 setup pattern). */
const E2E_STAFF_DELETE_SLUG = "e2e-staff-delete";
const ANCHOR_NAME = "E2E_ST_ANCHOR";
const NAME_BLOCK = "E2E_ST_BLOCK";
const NAME_OK = "E2E_ST_OK";

type Fixture = {
  salonId: string;
  slug: string;
  serviceId: string;
  anchorStaffId: string;
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

function staffRow(page: Page, displayName: string) {
  return page.locator(`li:has(input[value="${displayName}"])`);
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
  await page.getByRole("heading", { name: "Staff", exact: true }).waitFor({
    timeout: 45_000,
  });
}

async function seedSalonAnchorAndService(): Promise<Fixture> {
  await cleanupTestSalon(E2E_STAFF_DELETE_SLUG);

  const openingParsed: unknown = JSON.parse(DEFAULT_OPENING_HOURS_JSON);

  const { data: salon, error: salonErr } = await supabaseAdmin
    .from("salons")
    .insert({
      slug: E2E_STAFF_DELETE_SLUG,
      name: "E2E Staff Delete Salon",
      phone: "15558889999",
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

  const { data: staffRowInsert, error: staffErr } = await supabaseAdmin
    .from("staff")
    .insert({
      salon_id: salonId,
      name: ANCHOR_NAME,
      job_role: "nail_tech",
    })
    .select("id")
    .single();

  if (staffErr || !staffRowInsert?.id) {
    await supabaseAdmin.from("salons").delete().eq("id", salonId);
    throw new Error(staffErr?.message ?? "seedSalon: anchor staff insert failed");
  }

  const { data: svc, error: svcErr } = await supabaseAdmin
    .from("services")
    .insert({
      salon_id: salonId,
      name: "E2E_ST_Service",
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

  return {
    salonId,
    slug: E2E_STAFF_DELETE_SLUG,
    serviceId: svc.id as string,
    anchorStaffId: staffRowInsert.id as string,
  };
}

async function resetEphemeralStaffAndBookings(salonId: string): Promise<void> {
  const { error: bErr } = await supabaseAdmin
    .from("bookings")
    .delete()
    .eq("salon_id", salonId);
  if (bErr) throw new Error(bErr.message);

  const { error: sErr } = await supabaseAdmin
    .from("staff")
    .delete()
    .eq("salon_id", salonId)
    .in("name", [NAME_BLOCK, NAME_OK]);
  if (sErr) throw new Error(sErr.message);
}

async function getStaffByName(
  salonId: string,
  name: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("staff")
    .select("id")
    .eq("salon_id", salonId)
    .eq("name", name)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ?? null;
}

let fx: Fixture;

test.beforeAll(async () => {
  fx = await seedSalonAnchorAndService();
});

test.beforeEach(async () => {
  await resetEphemeralStaffAndBookings(fx.salonId);
});

test.afterAll(async () => {
  await cleanupTestSalon(E2E_STAFF_DELETE_SLUG);
});

test.describe("Setup staff delete", () => {
  test.describe.configure({ timeout: 60_000 });

  test("st-1: cannot delete staff with future booking", async ({ page }) => {
    const { data: blockStaff, error: insErr } = await supabaseAdmin
      .from("staff")
      .insert({
        salon_id: fx.salonId,
        name: NAME_BLOCK,
        job_role: "nail_tech",
      })
      .select("id")
      .single();

    if (insErr || !blockStaff?.id) {
      throw new Error(insErr?.message ?? "st-1: staff insert failed");
    }

    const blockId = blockStaff.id as string;
    const ymd = tomorrowYmdUtc();
    await seedDeskBooking(fx.salonId, {
      clientName: "E2E_ST_BOOK_FUTURE",
      serviceId: fx.serviceId,
      staffId: blockId,
      startIso: isoAtUtcYmdHourMinute(ymd, 14, 0),
      endIso: isoAtUtcYmdHourMinute(ymd, 14, 45),
      status: "pending",
      source: "appointment",
    });

    await gotoSetupStaff(page, fx.slug);

    await staffRow(page, NAME_BLOCK)
      .getByRole("button", { name: "Remove staff" })
      .click();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    const errBanner = page.locator(".text-nq-error").filter({
      hasText: /Reassign|upcoming|Nhân viên|booking sắp tới/i,
    });
    await expect(errBanner.first()).toBeVisible({ timeout: 15_000 });

    const stillThere = await getStaffByName(fx.salonId, NAME_BLOCK);
    expect(stillThere?.id).toBe(blockId);
  });

  test("st-2: can delete staff with only completed history", async ({
    page,
  }) => {
    const { data: okStaff, error: insErr } = await supabaseAdmin
      .from("staff")
      .insert({
        salon_id: fx.salonId,
        name: NAME_OK,
        job_role: "nail_tech",
      })
      .select("id")
      .single();

    if (insErr || !okStaff?.id) {
      throw new Error(insErr?.message ?? "st-2: staff insert failed");
    }

    const okId = okStaff.id as string;
    const ymd = yesterdayYmdUtc();
    const bookingId = await seedDeskBooking(fx.salonId, {
      clientName: "E2E_ST_BOOK_PAST",
      serviceId: fx.serviceId,
      staffId: okId,
      startIso: isoAtUtcYmdHourMinute(ymd, 11, 0),
      endIso: isoAtUtcYmdHourMinute(ymd, 11, 45),
      status: "completed",
      source: "appointment",
    });

    await gotoSetupStaff(page, fx.slug);

    await staffRow(page, NAME_OK)
      .getByRole("button", { name: "Remove staff" })
      .click();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    await expect(staffRow(page, NAME_OK)).toHaveCount(0, {
      timeout: 15_000,
    });

    const gone = await getStaffByName(fx.salonId, NAME_OK);
    expect(gone).toBeNull();

    const { data: bookingRow, error: bErr } = await supabaseAdmin
      .from("bookings")
      .select("id,status,staff_id")
      .eq("salon_id", fx.salonId)
      .eq("id", bookingId)
      .maybeSingle();

    if (bErr) throw new Error(bErr.message);
    expect(bookingRow?.id).toBe(bookingId);
    expect(bookingRow?.status).toBe("completed");
    expect(bookingRow?.staff_id).toBeNull();
  });
});
