import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  seedGroupTestSalon,
} from "./helpers";

const SLUG = "e2e-group-back-nav";

/**
 * Back-navigation contract: every back-jump (stepper click OR
 * footer Back button) must preserve fields the user already filled
 * on earlier steps. The state lives in `BookingGroupFlow`'s
 * `useState` hooks (hoisted parent), so the only way to lose data
 * is to remount the wrapper or to reset on transition — neither of
 * which should ever happen.
 */
test.describe("Group booking — back-nav preserves state", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("step 3 → back → step 2 fields still populated", async ({ page }) => {
    await gotoGroupFlow(page, SLUG);

    // STEP 1
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();

    // STEP 2 — fill both members.
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Linh", 1, 2);
    const p1Service = await page
      .getByTestId("group-member-0-service")
      .inputValue();
    const p2Staff = await page
      .getByTestId("group-member-1-staff")
      .inputValue();
    expect(p1Service.length).toBeGreaterThan(0);
    expect(p2Staff.length).toBeGreaterThan(0);

    await page.getByTestId("group-service-next").click();

    // STEP 3 — confirm we got here.
    await page
      .getByTestId("group-step-date-panel")
      .waitFor({ state: "visible" });

    // Footer Back → step 2 should still have the names + selections.
    // The Next.js dev overlay (`<nextjs-portal>`) sits over the
    // bottom-right corner of the mobile viewport, which overlaps
    // our sticky footer's Back button — coordinate-based clicks
    // (even with `force: true`) get caught by the portal. Native
    // `el.click()` dispatches the event straight to the button and
    // bypasses the z-order entirely. Production has no overlay so
    // this is a test-environment shim only.
    await page
      .getByTestId("group-back")
      .evaluate((el) => (el as HTMLButtonElement).click());
    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });

    await expect(page.getByTestId("group-member-0-name")).toHaveValue("Mai");
    await expect(page.getByTestId("group-member-1-name")).toHaveValue("Linh");
    await expect(page.getByTestId("group-member-0-service")).toHaveValue(
      p1Service,
    );
    await expect(page.getByTestId("group-member-1-staff")).toHaveValue(p2Staff);
  });

  test("stepper jump-back to step 1 preserves size", async ({ page }) => {
    await gotoGroupFlow(page, SLUG);

    // Pick size 3 (not the default 2) so the assertion is meaningful.
    await page.getByTestId("group-size-3").click();
    await expect(page.getByTestId("group-size-3")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByTestId("group-size-next").click();

    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });

    // 3 member cards visible.
    await expect(page.getByTestId("group-member-0")).toBeVisible();
    await expect(page.getByTestId("group-member-1")).toBeVisible();
    await expect(page.getByTestId("group-member-2")).toBeVisible();

    // Stepper has a clickable button only for steps < current. Step
    // 1 is in the past now → testid wraps a real <button>.
    await page.getByTestId("group-step-1").click();
    await page
      .getByTestId("group-step-size-panel")
      .waitFor({ state: "visible" });
    await expect(page.getByTestId("group-size-3")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("step 4 → back to step 3 → date + arrival pill preserved", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG);
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Linh", 1, 2);
    await page.getByTestId("group-service-next").click();

    const date = nextOpenDateYmd();
    await page.getByTestId("group-date-input").fill(date);
    await page.getByTestId("group-arrival-evening").click();
    await page.getByTestId("group-date-next").click();

    // Wait for step 4 to mount + scheduler to settle (loading
    // resolves to either arrangements or empty-state). Either is
    // fine — we're not asserting on scheduler output here.
    await page
      .getByTestId("group-step-arrangement-panel")
      .waitFor({ state: "visible" });
    await page
      .getByTestId("group-scheduling-loading")
      .waitFor({ state: "hidden", timeout: 20_000 });

    // Footer Back → step 3 should still have our date + evening.
    // The Next.js dev overlay (`<nextjs-portal>`) sits over the
    // bottom-right corner of the mobile viewport, which overlaps
    // our sticky footer's Back button — coordinate-based clicks
    // (even with `force: true`) get caught by the portal. Native
    // `el.click()` dispatches the event straight to the button and
    // bypasses the z-order entirely. Production has no overlay so
    // this is a test-environment shim only.
    await page
      .getByTestId("group-back")
      .evaluate((el) => (el as HTMLButtonElement).click());
    await page
      .getByTestId("group-step-date-panel")
      .waitFor({ state: "visible" });

    await expect(page.getByTestId("group-date-input")).toHaveValue(date);
    await expect(page.getByTestId("group-arrival-evening")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
