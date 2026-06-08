import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { seedGroupTestSalon } from "./helpers";

/**
 * Regression: a "Guest N" / "Khách N" placeholder that leaked into
 * client_profiles.name (from an un-named group member) must NOT be
 * surfaced as the customer's name. The gate treats such a profile as
 * "returning but needs a name" — it shows the name field instead of
 * greeting them "Welcome back, Guest 1".
 */

const SLUG = "e2e-guestname";
const POLLUTED_PHONE = "16045558881";
const REAL_PHONE = "16045558882";
// Placeholder profile BUT a real name on a past booking → fallback.
const FALLBACK_PHONE = "16045558884";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

test.describe("Gate — placeholder profile name is not surfaced", () => {
  test.beforeAll(async () => {
    const fx = await seedGroupTestSalon(SLUG);
    await supabase.from("client_profiles").upsert(
      [
        { phone: POLLUTED_PHONE, name: "Guest 1", visit_count: 3 },
        { phone: REAL_PHONE, name: "Real Name", visit_count: 2 },
        // Profile name is a placeholder, but a past booking has a real name.
        { phone: FALLBACK_PHONE, name: "Khách 2", visit_count: 1 },
      ],
      { onConflict: "phone" },
    );
    await supabase.from("bookings").insert({
      salon_id: fx.salonId,
      service_id: fx.serviceIds[0],
      staff_id: fx.staffIds[0],
      client_name: "Linda Real",
      client_phone: FALLBACK_PHONE,
      start_time_utc: "2026-05-01T18:00:00Z",
      end_time_utc: "2026-05-01T19:00:00Z",
      status: "completed",
      source: "appointment",
    });
  });
  test.afterAll(async () => {
    await supabase
      .from("client_profiles")
      .delete()
      .in("phone", [POLLUTED_PHONE, REAL_PHONE, FALLBACK_PHONE]);
    await cleanupTestSalon(SLUG);
  });

  test('"Guest 1" profile → no greeting, name field shown instead', async ({
    page,
  }) => {
    await page.goto(`/${SLUG}`);
    await expect(page.getByTestId("booking-phone-gate")).toBeVisible();

    await page.getByTestId("booking-entry-phone").fill(`+${POLLUTED_PHONE}`);
    // No "Welcome back, Guest 1" — the placeholder is suppressed.
    await expect(page.getByTestId("booking-entry-name")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("booking-entry-recognized")).toHaveCount(0);
  });

  test("real name profile → greeting shows, no name field", async ({
    page,
  }) => {
    await page.goto(`/${SLUG}`);
    await page.getByTestId("booking-entry-phone").fill(`+${REAL_PHONE}`);
    await expect(page.getByTestId("booking-entry-recognized")).toContainText(
      "Real Name",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("booking-entry-name")).toHaveCount(0);
  });

  test("placeholder profile but real name on a booking → fallback greets them", async ({
    page,
  }) => {
    await page.goto(`/${SLUG}`);
    await page.getByTestId("booking-entry-phone").fill(`+${FALLBACK_PHONE}`);
    // The profile name is "Khách 2" but the lookup falls back to the
    // real booking name "Linda Real".
    await expect(page.getByTestId("booking-entry-recognized")).toContainText(
      "Linda Real",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("booking-entry-name")).toHaveCount(0);
  });
});
