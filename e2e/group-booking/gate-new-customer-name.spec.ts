import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { seedGroupTestSalon } from "./helpers";

/**
 * Phone-first gate — NEW customer (phone not recognized) captures their
 * name right at the gate, and that name threads into the chosen flow
 * (Guest 1 for group).
 */

const SLUG = "e2e-gate-newname";
const NEW_PHONE = "16045559123";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

test.describe("Phone-first gate — new customer name", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
    // Ensure this phone is genuinely a NEW customer (no profile).
    await supabase.from("client_profiles").delete().eq("phone", NEW_PHONE);
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("new customer types name at the gate; it pre-fills Guest 1", async ({
    page,
  }) => {
    // Drive the gate directly (don't pre-enter a phone via gotoGroupFlow).
    await page.goto(`/${SLUG}`);
    await expect(page.getByTestId("booking-phone-gate")).toBeVisible();

    // New phone → no recognition → the name field appears.
    await page.getByTestId("booking-entry-phone").fill(`+${NEW_PHONE}`);
    await expect(page.getByTestId("booking-entry-name")).toBeVisible({
      timeout: 10_000,
    });
    // Returning-customer greeting must NOT show for a new phone.
    await expect(page.getByTestId("booking-entry-recognized")).toHaveCount(0);

    // Type the name → live greeting + commit.
    await page.getByTestId("booking-entry-name").fill("Hùng");
    await expect(page.getByTestId("booking-entry-newgreeting")).toContainText(
      "Hùng",
    );
    // Let the debounced commit land so the flow picks the name up.
    await page.waitForTimeout(600);

    // Into the group flow → Guest 1 is pre-filled with the typed name.
    await page.getByTestId("booking-type-group").click();
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();
    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });
    await expect(page.getByTestId("group-member-0-name")).toHaveValue("Hùng");
  });
});
