import { test, expect } from "@playwright/test";

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

/**
 * Case 7 (automated slice): viewport ≤768px stacks queue above timeline (`order-1` / `order-2`).
 * Real iPad Safari behavior remains manual (see deliverables).
 */
test.describe("Mobile layout", () => {
  test("daily brief keeps the schedule primary until details are requested", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, fx.slug);

    const summary = page.getByTestId("nailiq-daily-brief-summary");
    await expect(summary).toBeVisible();
    await expect(page.getByTestId("nailiq-daily-brief")).toHaveCount(0);

    await summary.click();
    await expect(page.getByTestId("nailiq-daily-brief")).toBeVisible();

    await page.getByTestId("nailiq-daily-brief-collapse").click();
    await expect(summary).toBeVisible();
  });

  test("case 7: narrow viewport places walk-in form above timeline", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReceptionistCenter(page, fx.slug);

    const form = page.getByTestId("walkin-add-form");
    const grid = page.getByTestId("vertical-day-view");

    await expect(form).toBeVisible();
    await expect(grid).toBeVisible();

    const formBox = await form.boundingBox();
    const gridBox = await grid.boundingBox();
    expect(formBox && gridBox).toBeTruthy();
    if (!formBox || !gridBox) return;

    expect(formBox.y).toBeLessThan(gridBox.y);
  });
});
