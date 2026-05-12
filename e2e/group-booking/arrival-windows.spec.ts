import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  seedGroupTestSalon,
} from "./helpers";

const SLUG = "e2e-group-arrival";

/**
 * Step-3 arrival-pill UI behavior. Each preset (morning / afternoon
 * / evening / specific) must toggle `aria-checked` correctly, and
 * the "specific" preset must reveal the native time input. We do
 * *not* submit — the goal is to lock the pill state machine, not
 * re-test the scheduler (covered by happy-path).
 */
test.describe("Group booking — arrival window pills", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test.beforeEach(async ({ page }) => {
    // Walk through steps 1 + 2 to land on the date/arrival panel.
    await gotoGroupFlow(page, SLUG);
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();
    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Linh", 1, 2);
    await page.getByTestId("group-service-next").click();
    await page
      .getByTestId("group-step-date-panel")
      .waitFor({ state: "visible" });
    // Date pre-filled so subsequent assertions don't get tangled
    // with the closed-day banner.
    await page.getByTestId("group-date-input").fill(nextOpenDateYmd());
  });

  test("morning pill selects with aria-checked=true", async ({ page }) => {
    await page.getByTestId("group-arrival-morning").click();
    await expect(page.getByTestId("group-arrival-morning")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("group-arrival-afternoon")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    // Specific-time input must NOT be present when a preset is active.
    await expect(page.getByTestId("group-specific-time")).toHaveCount(0);
  });

  test("afternoon pill selects with aria-checked=true", async ({ page }) => {
    await page.getByTestId("group-arrival-afternoon").click();
    await expect(page.getByTestId("group-arrival-afternoon")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("group-arrival-morning")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  test("evening pill selects with aria-checked=true", async ({ page }) => {
    await page.getByTestId("group-arrival-evening").click();
    await expect(page.getByTestId("group-arrival-evening")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("specific time pill reveals the time input", async ({ page }) => {
    // Specific-time input is hidden by default — it only renders
    // when arrivalKind === "specific".
    await expect(page.getByTestId("group-specific-time")).toHaveCount(0);

    await page.getByTestId("group-arrival-specific").click();
    await expect(page.getByTestId("group-arrival-specific")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const timeInput = page.getByTestId("group-specific-time");
    await expect(timeInput).toBeVisible();
    // Native <input type="time"> with step=300 (5-minute increments).
    await expect(timeInput).toHaveAttribute("type", "time");
    await expect(timeInput).toHaveAttribute("step", "300");

    // Switching back to a preset hides the input again.
    await page.getByTestId("group-arrival-morning").click();
    await expect(page.getByTestId("group-specific-time")).toHaveCount(0);
  });
});
