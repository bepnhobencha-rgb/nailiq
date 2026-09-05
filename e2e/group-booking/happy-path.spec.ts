import { expect, test } from "@playwright/test";

import { cleanupTestSalon, getGroupBookingStamps } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
  seedGroupTestSalon,
} from "./helpers";

const SLUG = "e2e-group-happy";

test.describe("Group booking — happy path", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("2-person group, BEST arrangement, successful submit", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG, { phone: "16045551234" });

    // ── STEP 1 — size ─────────────────────────────────────────
    await page.getByTestId("group-size-2").click();
    await expect(page.getByTestId("group-size-2")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByTestId("group-size-next").click();

    // ── STEP 2 — per-member service & staff ──────────────────
    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });
    // Person 1: first service, first staff.
    await fillMemberCard(page, 0, "Mai", 1, 1);
    // Person 2: first service, second staff (avoid in-card dup warning).
    await fillMemberCard(page, 1, "Linh", 1, 2);
    await page.getByTestId("group-service-next").click();

    // ── STEP 3 — date + arrival ──────────────────────────────
    await page
      .getByTestId("group-step-date-panel")
      .waitFor({ state: "visible" });
    // Date picker is now the visual calendar (post-2026-05-12).
    await pickDateInCalendar(page, nextOpenDateYmd());
    await page.getByTestId("group-arrival-afternoon").click();
    await expect(page.getByTestId("group-arrival-afternoon")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByTestId("group-date-next").click();

    // ── STEP 4 — AI arrangement ──────────────────────────────
    await page
      .getByTestId("group-step-arrangement-panel")
      .waitFor({ state: "visible" });
    // BEST card must be visible — for a fresh salon with no bookings
    // the aligned-anchor algorithm always returns at least the BEST
    // arrangement. Generous timeout because the scheduler does a
    // round-trip per-anchor against Supabase.
    const bestCard = page.getByTestId("group-arrangement-best");
    await expect(bestCard).toBeVisible({ timeout: 20_000 });
    await bestCard.click();
    await expect(bestCard).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("group-arrangement-next").click();

    // ── STEP 5 — confirm ─────────────────────────────────────
    await page
      .getByTestId("group-step-confirm-panel")
      .waitFor({ state: "visible" });
    await expect(page.getByTestId("group-primary-phone")).toHaveValue(
      /604.*555.*1234/,
    );
    // group-sms-consent only renders when consent was NOT already given at the
    // phone gate. gotoGroupFlow now checks the gate consent, so it may be absent.
    const groupSmsConsent = page.getByTestId("group-sms-consent");
    if (await groupSmsConsent.isVisible()) {
      await groupSmsConsent.check();
    }
    await expect(page.getByTestId("group-authoritative-receipt")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("group-confirm")).toBeEnabled({
      timeout: 15_000,
    });
    await page.getByTestId("group-confirm").click();

    // ── SUCCESS ─────────────────────────────────────────────
    await expect(page.getByTestId("booking-group-success")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/confirmed|thành công/i)).toBeVisible();
    // FIX 18 (Task #04-A) — new reference format
    // `#GRP-YYYYMMDD-XXXX`. Date prefix is the salon-local booking
    // date (always 8 digits), 4-hex suffix from the group_id UUID.
    await expect(page.getByText(/#GRP-\d{8}-[A-F0-9]{4}/)).toBeVisible();

    // ── STAMPS ──────────────────────────────────────────────
    // booking_channel has to survive the trip through the server action: this
    // flow submits from the browser, where an anon UPDATE on `bookings` hits 0
    // rows and reports success. Polled because the action defers to after().
    await expect
      .poll(
        async () => {
          const rows = await getGroupBookingStamps(SLUG);
          return rows.map((b) => b.booking_channel).sort();
        },
        { timeout: 15_000 },
      )
      .toEqual(["online", "online"]);

    // This salon has phone_otp_enabled=false, so nothing verified the organizer
    // — the stamp must not claim otherwise. (otp-gate.spec covers the OTP case.)
    const rows = await getGroupBookingStamps(SLUG);
    expect(rows.every((b) => b.verification_method === null)).toBe(true);
  });
});
