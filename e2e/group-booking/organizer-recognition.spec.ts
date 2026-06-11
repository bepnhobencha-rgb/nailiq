import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
  seedGroupTestSalon,
} from "./helpers";

/**
 * Step-5 organizer recognition + success-screen QR self-claim.
 *
 * A: when the primary-contact phone matches a returning customer
 *    (`client_profiles`), the confirm step greets them by name + VIP.
 * B: the success screen renders a scan-to-join QR for the Party Link
 *    so each guest can confirm their own slot.
 */

const SLUG = "e2e-group-organizer";
const ORGANIZER_PHONE_DIGITS = "16045550777";
const ORGANIZER_NAME = "Mai Organizer";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

test.describe("Group booking — organizer recognition + QR", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
    // Global (cross-salon) returning customer the lookup will match.
    await supabase.from("client_profiles").upsert(
      {
        phone: ORGANIZER_PHONE_DIGITS,
        name: ORGANIZER_NAME,
        is_vip: true,
        visit_count: 5,
      },
      { onConflict: "phone" },
    );
  });
  test.afterAll(async () => {
    await supabase
      .from("client_profiles")
      .delete()
      .eq("phone", ORGANIZER_PHONE_DIGITS);
    await cleanupTestSalon(SLUG);
  });

  test("recognizes the returning organizer and shows the scan-to-join QR", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG);
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();
    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Linh", 1, 2);
    await page.getByTestId("group-service-next").click();

    await page.getByTestId("group-step-date-panel").waitFor({ state: "visible" });
    await pickDateInCalendar(page, nextOpenDateYmd());
    await page.getByTestId("group-arrival-afternoon").click();
    await page.getByTestId("group-date-next").click();

    await page
      .getByTestId("group-step-arrangement-panel")
      .waitFor({ state: "visible" });
    const best = page.getByTestId("group-arrangement-best");
    await expect(best).toBeVisible({ timeout: 20_000 });
    await best.click();
    await page.getByTestId("group-arrangement-next").click();

    // ── STEP 5 — type the returning organizer's phone ──────────
    await page
      .getByTestId("group-step-confirm-panel")
      .waitFor({ state: "visible" });
    await page.getByTestId("group-primary-phone").fill(`+${ORGANIZER_PHONE_DIGITS}`);

    // A — greeting card recognizes them by name.
    const greeting = page.getByTestId("group-organizer-recognized");
    await expect(greeting).toBeVisible({ timeout: 10_000 });
    await expect(greeting).toContainText(ORGANIZER_NAME);

    // Submit → success.
    await page.getByTestId("group-sms-consent").check();
    await page.getByTestId("group-confirm").click();
    await expect(page.getByTestId("booking-group-success")).toBeVisible({
      timeout: 15_000,
    });

    // B — Party Link share box + scan-to-join QR appear once
    // createPartyLink resolves (server action; generous timeout for a
    // cold-compiled route on the first hit).
    await expect(page.getByTestId("party-link-share")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("party-link-qr")).toBeVisible();
  });
});
