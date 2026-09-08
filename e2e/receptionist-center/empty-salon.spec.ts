import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalonMember,
} from "../helpers/db";
import { DEFAULT_OPENING_HOURS_JSON } from "@/shared/dashboard/openingHoursDefaults";

import { gotoReceptionistCenter, supabaseAdmin } from "./helpers";

/** No services, no staff — distinct from `e2e-receptionist-center` fixture. */
const E2E_EMPTY = "e2e-empty-salon-center";
/** Catalog has services but zero staff rows. */
const E2E_NO_STAFF = "e2e-empty-salon-no-staff";
const owners = new Map<string, Awaited<ReturnType<typeof seedTestSalonMember>>>();

async function seedSalonBare(slug: string, withService: boolean): Promise<string> {
  await cleanupTestSalon(slug);

  const openingParsed: unknown = JSON.parse(DEFAULT_OPENING_HOURS_JSON);

  const { data: salon, error: salonErr } = await supabaseAdmin
    .from("salons")
    .insert({
      slug,
      name: withService ? "E2E Empty No Staff" : "E2E Empty Salon",
      phone: "15559990001",
      profile_complete: true,
      timezone: "UTC",
      opening_hours: openingParsed,
      setup_wizard_completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (salonErr || !salon?.id) {
    throw new Error(salonErr?.message ?? "empty-salon seed: salon insert failed");
  }

  const salonId = salon.id as string;

  if (withService) {
    const { error: svcErr } = await supabaseAdmin.from("services").insert({
      salon_id: salonId,
      name: "E2E_ES_Service",
      price_cents: 2000,
      duration_minutes: 30,
      buffer_minutes: 5,
    });
    if (svcErr) throw new Error(svcErr.message);
  }
  return salonId;
}

async function gotoAsOwner(page: Page, slug: string): Promise<void> {
  const owner = owners.get(slug);
  if (!owner) throw new Error(`empty-salon owner fixture missing: ${slug}`);

  // Staff setup reads account-access data and requires a real Auth session;
  // a demo cookie can open the center but cannot authorize that read.
  const digest = createHash("sha256").update(owner.email).digest("hex");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
  });
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(owner.email);
  await page.locator('input[type="password"]').fill(owner.password);
  await page.getByTestId("password-signin-submit").click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
  await gotoReceptionistCenter(page, slug, { useDemoCookie: false });
  expect(
    (await page.context().cookies()).some((cookie) => cookie.name === "nailiq-demo-slug"),
  ).toBe(false);
}

test.beforeAll(async () => {
  for (const slug of [E2E_EMPTY, E2E_NO_STAFF]) {
    const salonId = await seedSalonBare(slug, slug === E2E_NO_STAFF);
    owners.set(slug, await seedTestSalonMember(salonId, "owner"));
    const { count, error } = await supabaseAdmin
      .from("staff")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId);
    expect(error).toBeNull();
    expect(count, "an owner account must not populate the empty staff fixture").toBe(0);
  }
});

test.afterAll(async () => {
  try {
    await cleanupTestSalon(E2E_EMPTY);
    await cleanupTestSalon(E2E_NO_STAFF);
  } finally {
    for (const owner of owners.values()) await cleanupTestUser(owner.userId);
    owners.clear();
  }
});

test.describe("Receptionist Center — empty salon setup", () => {
  test.describe.configure({ timeout: 60_000 });

  test("es-1: 0 services and 0 staff shows banner and disables form", async ({
    page,
  }) => {
    await gotoAsOwner(page, E2E_EMPTY);

    await expect(page.getByTestId("setup-incomplete-banner")).toBeVisible();
    await expect(
      page.getByText("Setup incomplete", { exact: true }),
    ).toBeVisible();

    await expect(page.getByTestId("walkin-submit")).toBeDisabled();

    await page.getByRole("link", { name: "Go to Setup →" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${E2E_EMPTY}/setup/services`),
    );
    await expect(page.getByRole("heading", { name: "Services", level: 1 })).toBeVisible();
  });

  test("es-2: services but no staff shows banner and CTA targets staff setup", async ({
    page,
  }) => {
    await gotoAsOwner(page, E2E_NO_STAFF);

    await expect(page.getByTestId("setup-incomplete-banner")).toBeVisible();
    await expect(
      page.getByText("Setup incomplete", { exact: true }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Go to Setup →" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${E2E_NO_STAFF}/setup/staff`),
    );
    // The URL can change before a streamed page redirects. Require the
    // authorized destination content so that transition cannot pass this test.
    await expect(page.getByRole("heading", { name: "Staff · 0", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Add staff", exact: true })).toBeVisible();
  });
});
