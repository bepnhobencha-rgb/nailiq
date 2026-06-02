import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { DEFAULT_OPENING_HOURS_JSON } from "@/shared/dashboard/openingHoursDefaults";

import { seedDeskBooking, supabaseAdmin } from "./helpers";

// Append GITHUB_RUN_ID (or a local fallback) so parallel CI runs on different
// PRs each get their own salon and cannot stomp each other's fixtures.
const _RUN_SUFFIX =
  process.env.GITHUB_RUN_ID ??
  process.env.PLAYWRIGHT_WORKER_INDEX ??
  String(Date.now()).slice(-6);

/** Run-scoped slug; torn down in afterAll. */
const E2E_SERVICE_DELETE_SLUG = `e2e-service-delete-${_RUN_SUFFIX}`;
const NAME_IN_USE = "E2E_SD_IN_USE";
const NAME_UNUSED = "E2E_SD_UNUSED";

type Fixture = {
  salonId: string;
  slug: string;
  staffId: string;
};

function tomorrowYmdUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
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

function serviceRow(page: Page, serviceName: string) {
  return page.locator(`li:has(input[value="${serviceName}"])`);
}

async function gotoSetupServices(page: Page, slug: string): Promise<void> {
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

  await page.goto(`/dashboard/${encodeURIComponent(slug)}/setup/services`);
  await page.getByRole("heading", { name: "Services" }).waitFor({
    timeout: 45_000,
  });
}

async function seedSalonAndStaff(): Promise<Fixture> {
  await cleanupTestSalon(E2E_SERVICE_DELETE_SLUG);

  const openingParsed: unknown = JSON.parse(DEFAULT_OPENING_HOURS_JSON);

  const { data: salon, error: salonErr } = await supabaseAdmin
    .from("salons")
    .insert({
      slug: E2E_SERVICE_DELETE_SLUG,
      name: "E2E Service Delete Salon",
      phone: "15559998888",
      profile_complete: true,
      timezone: "UTC",
      opening_hours: openingParsed,
      setup_wizard_completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (salonErr || !salon?.id) {
    throw new Error(salonErr?.message ?? "seedSalonAndStaff: salon insert failed");
  }

  const salonId = salon.id as string;

  const { data: staffRow, error: staffErr } = await supabaseAdmin
    .from("staff")
    .insert({
      salon_id: salonId,
      name: "E2E_SD_Staff",
      job_role: "nail_tech",
    })
    .select("id")
    .single();

  if (staffErr || !staffRow?.id) {
    await supabaseAdmin.from("salons").delete().eq("id", salonId);
    throw new Error(staffErr?.message ?? "seedSalonAndStaff: staff insert failed");
  }

  return {
    salonId,
    slug: E2E_SERVICE_DELETE_SLUG,
    staffId: staffRow.id as string,
  };
}

async function resetTwoServices(salonId: string): Promise<{
  inUseId: string;
  unusedId: string;
}> {
  const { error: bErr } = await supabaseAdmin
    .from("bookings")
    .delete()
    .eq("salon_id", salonId);
  if (bErr) throw new Error(bErr.message);

  const { error: sErr } = await supabaseAdmin
    .from("services")
    .delete()
    .eq("salon_id", salonId);
  if (sErr) throw new Error(sErr.message);

  const { data: rows, error: insErr } = await supabaseAdmin
    .from("services")
    .insert([
      {
        salon_id: salonId,
        name: NAME_IN_USE,
        price_cents: 1000,
        duration_minutes: 30,
        buffer_minutes: 5,
      },
      {
        salon_id: salonId,
        name: NAME_UNUSED,
        price_cents: 2000,
        duration_minutes: 45,
        buffer_minutes: 10,
      },
    ])
    .select("id,name");

  if (insErr || !rows?.length) {
    throw new Error(insErr?.message ?? "resetTwoServices: insert failed");
  }

  const byName = Object.fromEntries(
    rows.map((r) => [String(r.name), String(r.id)]),
  ) as Record<string, string>;

  const inUseId = byName[NAME_IN_USE];
  const unusedId = byName[NAME_UNUSED];
  if (!inUseId || !unusedId) {
    throw new Error("resetTwoServices: could not resolve service ids");
  }

  return { inUseId, unusedId };
}

async function getServiceRowById(
  serviceId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("services")
    .select("id")
    .eq("id", serviceId)
    .is("deleted_at" as never, null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ?? null;
}

async function resolveServiceIds(salonId: string): Promise<{
  inUseId: string;
  unusedId: string;
}> {
  const { data, error } = await supabaseAdmin
    .from("services")
    .select("id,name")
    .eq("salon_id", salonId);

  if (error) throw new Error(error.message);

  const byName = Object.fromEntries(
    (data ?? []).map((r) => [String(r.name), String(r.id)]),
  ) as Record<string, string>;

  const inUseId = byName[NAME_IN_USE];
  const unusedId = byName[NAME_UNUSED];
  if (!inUseId || !unusedId) {
    throw new Error("resolveServiceIds: expected catalog rows missing");
  }

  return { inUseId, unusedId };
}

let fx: Fixture;

test.beforeAll(async () => {
  fx = await seedSalonAndStaff();
});

test.beforeEach(async () => {
  await resetTwoServices(fx.salonId);
});

test.afterAll(async () => {
  await cleanupTestSalon(E2E_SERVICE_DELETE_SLUG);
});

test.describe("Setup services delete", () => {
  test("sd-1: cannot delete service with active booking", async ({ page }) => {
    const { inUseId } = await resolveServiceIds(fx.salonId);

    const ymd = tomorrowYmdUtc();
    await seedDeskBooking(fx.salonId, {
      clientName: "E2E_SD_BOOK_CLIENT",
      serviceId: inUseId,
      staffId: fx.staffId,
      startIso: isoAtUtcYmdHourMinute(ymd, 14, 0),
      endIso: isoAtUtcYmdHourMinute(ymd, 14, 45),
      status: "pending",
      source: "appointment",
    });

    await gotoSetupServices(page, fx.slug);

    await serviceRow(page, NAME_IN_USE)
      .getByRole("button", { name: "Delete service" })
      .click();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    const errBanner = page.locator(".text-nq-error").filter({
      hasText: /đang được dùng|is used/i,
    });
    await expect(errBanner.first()).toBeVisible({ timeout: 15_000 });

    const stillThere = await getServiceRowById(inUseId);
    expect(stillThere?.id).toBe(inUseId);
  });

  test("sd-2: can delete unused service", async ({ page }) => {
    const { unusedId } = await resolveServiceIds(fx.salonId);

    await gotoSetupServices(page, fx.slug);

    await serviceRow(page, NAME_UNUSED)
      .getByRole("button", { name: "Delete service" })
      .click();
    await page.getByRole("button", { name: "Confirm delete" }).click();

    await expect(serviceRow(page, NAME_UNUSED)).toHaveCount(0, {
      timeout: 15_000,
    });

    const gone = await getServiceRowById(unusedId);
    expect(gone).toBeNull();
  });
});
