/**
 * Group booking — OTP gate (anti-sabotage).
 *
 * A salon with phone_otp_enabled + booking_verification_mode='always_otp' must
 * force the organizer through phone OTP before a group booking is created — the
 * same shield the individual flow has. Closes the "$1,700 group with no
 * friction" hole from the Hi-Lite QA re-test.
 *
 * Requires DEMO_OTP=true (magic code 000000), same as booking-otp.spec.
 */
import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { fillReactInput } from "../receptionist-center/helpers";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
  seedGroupTestSalon,
} from "./helpers";

const SLUG = "e2e-group-otp";
const OTP_DEMO_CODE = "000000";

test.describe("Group booking — OTP gate", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG, {
      phone_otp_enabled: true,
      booking_verification_mode: "always_otp",
    });
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("always_otp forces the organizer through OTP before the group books", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG);

    // Step 1 — size
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();

    // Step 2 — services
    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Linh", 1, 2);
    await page.getByTestId("group-service-next").click();

    // Step 3 — date + arrival
    await page
      .getByTestId("group-step-date-panel")
      .waitFor({ state: "visible" });
    await pickDateInCalendar(page, nextOpenDateYmd());
    await page.getByTestId("group-arrival-afternoon").click();
    await page.getByTestId("group-date-next").click();

    // Step 4 — arrangement
    await page
      .getByTestId("group-step-arrangement-panel")
      .waitFor({ state: "visible" });
    const bestCard = page.getByTestId("group-arrangement-best");
    await expect(bestCard).toBeVisible({ timeout: 20_000 });
    await bestCard.click();
    await page.getByTestId("group-arrangement-next").click();

    // Step 5 — confirm → click confirm
    await page
      .getByTestId("group-step-confirm-panel")
      .waitFor({ state: "visible" });
    await page.getByTestId("group-primary-phone").fill("+16045551234");
    await page.getByTestId("group-sms-consent").check();
    await page.getByTestId("group-confirm").click();

    // GATE: the OTP panel must appear — the group is NOT booked yet.
    await expect(page.locator("#otp-code")).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByTestId("booking-group-success")).toHaveCount(0);

    // Enter the demo OTP → group now books.
    await fillReactInput(page.locator("#otp-code"), OTP_DEMO_CODE);
    await page.locator("#otp-code").press("Enter");

    await expect(page.getByTestId("booking-group-success")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/#GRP-\d{8}-[A-F0-9]{4}/)).toBeVisible();
  });
});
