import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { DEFAULT_OPENING_HOURS_JSON } from "@/shared/dashboard/openingHoursDefaults";

import { gotoReceptionistCenter, supabaseAdmin } from "./helpers";

/** No services, no staff — distinct from `e2e-receptionist-center` fixture. */
const E2E_EMPTY = "e2e-empty-salon-center";
/** Catalog has services but zero staff rows. */
const E2E_NO_STAFF = "e2e-empty-salon-no-staff";

async function seedSalonBare(slug: string, withService: boolean): Promise<void> {
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
}

test.beforeAll(async () => {
  await seedSalonBare(E2E_EMPTY, false);
  await seedSalonBare(E2E_NO_STAFF, true);
});

test.afterAll(async () => {
  await cleanupTestSalon(E2E_EMPTY);
  await cleanupTestSalon(E2E_NO_STAFF);
});

test.describe("Receptionist Center — empty salon setup", () => {
  test.describe.configure({ timeout: 60_000 });

  test("es-1: 0 services and 0 staff shows banner and disables form", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, E2E_EMPTY);

    await expect(page.getByTestId("setup-incomplete-banner")).toBeVisible();
    await expect(
      page.getByText("Setup incomplete", { exact: true }),
    ).toBeVisible();

    await expect(
      page
        .getByTestId("walkin-add-form")
        .getByRole("button", { name: "Add to queue" }),
    ).toBeDisabled();

    await page.getByRole("link", { name: "Go to Setup →" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${E2E_EMPTY}/setup/services`),
    );
  });

  test("es-2: services but no staff shows banner and CTA targets staff setup", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, E2E_NO_STAFF);

    await expect(page.getByTestId("setup-incomplete-banner")).toBeVisible();
    await expect(
      page.getByText("Setup incomplete", { exact: true }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Go to Setup →" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${E2E_NO_STAFF}/setup/staff`),
    );
  });
});
