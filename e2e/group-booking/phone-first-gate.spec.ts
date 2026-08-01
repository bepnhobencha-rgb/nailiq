import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import {
  cleanupTestSalon,
  setReactInputValue,
} from "../helpers/db";
import { seedGroupTestSalon } from "./helpers";

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
    // Land on the booking page directly — this test drives the gate
    // itself, so it must not pre-enter a phone via gotoGroupFlow.
    await page.goto(`/${SLUG}`);

    const gate = page.getByTestId("booking-phone-gate");
    await expect(gate).toBeVisible();

    // Enter the returning customer's phone → recognized, but PRIVACY (S1):
    // the greeting is generic and must NOT reveal the stored name to anyone
    // who merely types a phone number.
    // CountryPhoneField's inner input takes the 10-digit NATIONAL number; the
    // full E.164 would be sliced to a bogus area code and rejected.
    // Use the React-aware helper so the controlled CountryPhoneField receives
    // an input event even when hydration finishes just after the gate appears.
    await setReactInputValue(
      page.getByTestId("booking-entry-phone"),
      PHONE.slice(-10),
    );
    const recognized = page.getByTestId("booking-entry-recognized");
    await expect(recognized).toBeVisible({ timeout: 10_000 });
    await expect(recognized).not.toContainText(NAME);

    // A recognized customer satisfies the name requirement from their profile,
    // but SMS consent is still required before the flow mounts.
    await page.getByTestId("sms-consent").check();

    // Switch to Individual → the flow should start on service selection
    // (phone step skipped because the gate already captured it).
    await page.getByTestId("booking-type-individual").click();
    await expect(
      page.locator('[data-testid="service-tile-select"]').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
