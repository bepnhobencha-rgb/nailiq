import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { gotoGroupFlow, seedGroupTestSalon } from "./helpers";

/**
 * Phone-first entry gate (above the Individual/Group choice):
 *  - recognizes a returning customer by phone, and
 *  - threads the phone into the chosen flow so the individual flow
 *    skips its own phone step (lands on service selection).
 */

const SLUG = "e2e-phone-first";
const PHONE = "16045550555";
const NAME = "Mai Returning";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

test.describe("Phone-first entry gate", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
    await supabase
      .from("client_profiles")
      .upsert(
        { phone: PHONE, name: NAME, is_vip: true, visit_count: 4 },
        { onConflict: "phone" },
      );
  });
  test.afterAll(async () => {
    await supabase.from("client_profiles").delete().eq("phone", PHONE);
    await cleanupTestSalon(SLUG);
  });

  test("recognizes the customer and skips the individual phone step", async ({
    page,
  }) => {
    // gotoGroupFlow opens /<slug>?mode=group; the gate sits above both
    // flows so it's present regardless of mode.
    await gotoGroupFlow(page, SLUG);

    const gate = page.getByTestId("booking-phone-gate");
    await expect(gate).toBeVisible();

    // Enter the returning customer's phone → recognized greeting.
    await page.getByTestId("booking-entry-phone").fill(`+${PHONE}`);
    await expect(page.getByTestId("booking-entry-recognized")).toContainText(
      NAME,
      { timeout: 10_000 },
    );

    // Switch to Individual → the flow should start on service selection
    // (phone step skipped because the gate already captured it).
    await page.getByTestId("booking-type-individual").click();
    await expect(
      page.locator('[data-testid="service-tile-select"]').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
