/**
 * Visual QA + regression: Basic Mode must stay Basic across the
 * Yesterday/Today/Tomorrow date tabs. Regression guard for the bug where
 * `basicModeActive` was gated on `isViewingToday`, so switching to Tomorrow
 * reverted the whole UI to the dense layout (density slider, owner badge,
 * Day/Week/Month toggle, and the full party-card strip all reappeared).
 *
 * The chrome flags are NOT time-dependent (basicChrome = basicMode &&
 * viewMode === "day"), so this is a deterministic check — no clock-boundary
 * seeding involved.
 */
import { test, expect, type Page } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
});
test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});
test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

/** Assert the simplified Basic chrome is intact on the currently-shown date. */
async function expectBasicChrome(page: Page, label: string) {
  // Basic header title.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Receptionist",
    { timeout: 10_000 },
  );
  // Density slider, Day/Week/Month toggle, owner badge — all hidden in Basic.
  await expect(page.getByTestId("density-slider"), `${label}: density hidden`).toHaveCount(0);
  await expect(page.getByTestId("view-mode-toggle"), `${label}: view toggle hidden`).toHaveCount(0);
  await expect(page.getByTestId("role-badge-owner"), `${label}: owner badge hidden`).toHaveCount(0);
  // Full party-card strip hidden by default in Basic.
  await expect(page.getByTestId("party-card-panel"), `${label}: party strip hidden`).toHaveCount(0);
  // Basic toggle still reachable (so the user can leave Basic from any tab).
  await expect(page.getByTestId("basic-mode-toggle"), `${label}: toggle present`).toBeVisible();
}

test.describe("Basic Mode date-tab consistency", () => {
  test("stays Basic when switching Today → Tomorrow", async ({ page }) => {
    // Enable Basic before the app mounts (per-device localStorage flag).
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("nailiq-basic-mode", "1");
      } catch {
        /* private mode — ignore */
      }
    });

    await gotoReceptionistCenter(page, fx.slug);

    // ── TODAY ──────────────────────────────────────────────────────
    await expect(page.getByTestId("basic-cockpit")).toBeVisible();
    await expectBasicChrome(page, "today");
    await page.screenshot({
      path: "test-results/basic-today.png",
      fullPage: true,
    });

    // ── TOMORROW ───────────────────────────────────────────────────
    await page.getByTestId("date-switcher-tomorrow").click();
    // Grid re-renders for the new date; wait for the day-load to settle.
    await page.getByTestId("staff-timeline-grid").first().waitFor({ state: "visible" });
    await expect(page.getByTestId("date-switcher-tomorrow")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // The whole point: chrome is STILL Basic on Tomorrow.
    await expectBasicChrome(page, "tomorrow");
    // The live cockpit is today-only (a future date has no "now").
    await expect(page.getByTestId("basic-cockpit")).toHaveCount(0);
    await page.screenshot({
      path: "test-results/basic-tomorrow.png",
      fullPage: true,
    });

    // ── BACK TO TODAY ──────────────────────────────────────────────
    await page.getByTestId("date-switcher-today").click();
    await expect(page.getByTestId("basic-cockpit")).toBeVisible();
    await expectBasicChrome(page, "back-to-today");
  });
});
