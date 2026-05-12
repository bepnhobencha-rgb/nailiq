import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
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
    await gotoGroupFlow(page, SLUG);

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
    await page.getByTestId("group-primary-phone").fill("+16045551234");
    await page.getByTestId("group-confirm").click();

    // ── SUCCESS ─────────────────────────────────────────────
    await expect(page.getByTestId("booking-group-success")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/confirmed|thành công/i)).toBeVisible();
    // Reference label is `${groupRef} #${first8charsOfGroupId}` —
    // the first 8 chars of a UUID are uppercase alphanumerics. Match
    // the prefix loosely (label may be "Reference" or "Mã đặt lịch").
    await expect(page.getByText(/#[A-F0-9]{8}/)).toBeVisible();
  });
});
