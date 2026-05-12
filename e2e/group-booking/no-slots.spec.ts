import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  nextSundayYmd,
  seedGroupTestSalon,
} from "./helpers";

const SLUG = "e2e-group-no-slots";

/**
 * Empty-state coverage for step 3 + step 4:
 *
 *   - Salon closed on the picked weekday → step-3 banner blocks the
 *     "Continue" CTA (`group-date-closed`).
 *   - Scheduler returns zero arrangements → step-4 empty state
 *     (`group-scheduling-empty[data-reason]`) with a "Try another
 *     date" button that returns the user to step 3.
 *
 * For the second case we use the *specific-time* arrival window
 * with a time that's outside the salon's 09:00–18:00 hours; the
 * scheduler clamps the window to opening_hours and gets an empty
 * range → `no_slots`. Deterministic and doesn't depend on staff
 * availability.
 */
test.describe("Group booking — empty states", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("closed weekday shows step-3 closed banner + disables Continue", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG);
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Linh", 1, 2);
    await page.getByTestId("group-service-next").click();

    // Sunday is closed in the default opening_hours.
    const sunday = nextSundayYmd();
    await page.getByTestId("group-date-input").fill(sunday);

    // Closed banner visible.
    await expect(page.getByTestId("group-date-closed")).toBeVisible();
    // Continue CTA is disabled — the BookingGroupFlow refuses to
    // advance off a closed day even before the scheduler runs.
    await expect(page.getByTestId("group-date-next")).toBeDisabled();
  });

  test("specific-time outside hours → step-4 empty state + Try-another-date returns to step 3", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG);
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Linh", 1, 2);
    await page.getByTestId("group-service-next").click();

    await page.getByTestId("group-date-input").fill(nextOpenDateYmd());
    await page.getByTestId("group-arrival-specific").click();
    // 03:00 — well outside default hours (09:00-18:00). The ±90min
    // window around 03:00 = 01:30–04:30, which clamps to nothing.
    await page.getByTestId("group-specific-time").fill("03:00");
    await page.getByTestId("group-date-next").click();

    // Step 4 mounts — wait for the scheduler to finish, then assert
    // empty state with data-reason="no_slots".
    await page
      .getByTestId("group-step-arrangement-panel")
      .waitFor({ state: "visible" });
    const empty = page.getByTestId("group-scheduling-empty");
    await expect(empty).toBeVisible({ timeout: 20_000 });
    await expect(empty).toHaveAttribute("data-reason", "no_slots");
    // No arrangement cards in this state.
    await expect(page.getByTestId("group-arrangement-best")).toHaveCount(0);
    // Continue CTA stays disabled because there's nothing to confirm.
    await expect(page.getByTestId("group-arrangement-next")).toBeDisabled();

    // "Try another date" → returns to step 3 (date panel).
    await page.getByRole("button", { name: /try another date/i }).click();
    await expect(page.getByTestId("group-step-date-panel")).toBeVisible();
  });
});
