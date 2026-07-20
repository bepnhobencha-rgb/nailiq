/**
 * Group booking — gate-first OTP (anti-sabotage + no double-OTP).
 *
 * A salon with phone_otp_enabled + booking_verification_mode='always_otp' forces
 * the organizer through phone OTP before ANY booking — the same shield the
 * individual flow has (closes the "$1,700 group with no friction" Hi-Lite hole).
 *
 * Since gate-first OTP (commit a4042c5), that verification happens at the ENTRY
 * GATE, before the group toggle even appears. The verified session is threaded
 * into BookingGroupFlow (`initialOtpSessionId`, #763), so the organizer is NOT
 * asked for a SECOND code after Confirm. This test proves both halves: the gate
 * blocks the group until verified, and Confirm books directly afterwards with
 * exactly one SMS send.
 *
 * Requires DEMO_OTP=true (magic code 000000), same as booking-otp.spec.
 */
import { expect, test } from "@playwright/test";

import { cleanupTestSalon, getGroupBookingStamps } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
  seedGroupTestSalon,
} from "./helpers";

const SLUG = "e2e-group-otp";

test.describe("Group booking — gate-first OTP", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG, {
      phone_otp_enabled: true,
      booking_verification_mode: "always_otp",
    });
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("gate OTP verifies the organizer once; the group books without a second OTP", async ({
    page,
  }) => {
    let sendCount = 0;
    await page.route("**/api/booking-otp/send", async (route) => {
      if (route.request().method() === "POST") sendCount += 1;
      await route.continue();
    });

    // Gate: phone + name + consent + OTP (exactly one SMS send). The group toggle
    // is behind `flowReady`, so it does not appear until the gate OTP is verified.
    await gotoGroupFlow(page, SLUG, { otp: true });

    // Step 1 — size
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();

    // Step 2 — services
    await page.getByTestId("group-step-service-panel").waitFor({ state: "visible" });
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Linh", 1, 2);
    await page.getByTestId("group-service-next").click();

    // Step 3 — date + arrival
    await page.getByTestId("group-step-date-panel").waitFor({ state: "visible" });
    await pickDateInCalendar(page, nextOpenDateYmd());
    await page.getByTestId("group-arrival-afternoon").click();
    await page.getByTestId("group-date-next").click();

    // Step 4 — arrangement
    await page.getByTestId("group-step-arrangement-panel").waitFor({ state: "visible" });
    const bestCard = page.getByTestId("group-arrangement-best");
    await expect(bestCard).toBeVisible({ timeout: 20_000 });
    await bestCard.click();
    await page.getByTestId("group-arrangement-next").click();

    // Step 5 — confirm. The primary phone is pre-filled with the gate (verified)
    // phone and SMS consent came from the gate, so Confirm is ready. Do NOT
    // change the phone — the threaded gate session is bound to it.
    await page.getByTestId("group-step-confirm-panel").waitFor({ state: "visible" });
    await page.getByTestId("group-confirm").click();

    // The group books directly — NO second OTP panel — because the gate session
    // already proves the phone (#763). And only the ONE gate SMS was sent.
    await expect(page.getByTestId("booking-group-success")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/#GRP-\d{8}-[A-F0-9]{4}/)).toBeVisible();
    await expect(page.locator("#otp-code")).toHaveCount(0);
    expect(sendCount).toBe(1);

    // ── STAMPS ──────────────────────────────────────────────
    // The gate OTP verified the organizer's phone, so the organizer row carries
    // the evidence. Polled because the stamp action defers to after().
    await expect
      .poll(
        async () => {
          const rows = await getGroupBookingStamps(SLUG);
          return rows[0]?.verification_method ?? null;
        },
        { timeout: 15_000 },
      )
      .toBe("otp");

    const rows = await getGroupBookingStamps(SLUG);
    expect(rows.every((b) => b.booking_channel === "online")).toBe(true);
    expect(rows[0]?.otp_session_id).not.toBeNull();
    // Members share the organizer's phone but hold no evidence of their own —
    // marking them verified would overstate what the OTP actually proved.
    expect(
      rows.filter((b) => !b.is_group_organizer).every((b) => b.verification_method === null),
    ).toBe(true);
  });
});
