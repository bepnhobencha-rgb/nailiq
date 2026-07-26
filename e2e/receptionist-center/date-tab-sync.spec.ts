import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  seedWalkin,
  testClientNameMarker,
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

test.describe("date-tab-sync", () => {
  test("case dt-1: walk-in queue hidden when viewing yesterday", async ({ page }) => {
    const marker = testClientNameMarker();
    await seedWalkin(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
    });

    await gotoReceptionistCenter(page, fx.slug);
    await expect(page.getByTestId("walkin-queue-sidebar")).toBeVisible();
    await expect(
      page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });

    // On mobile the queue backdrop (z-30) sits above the date-switcher; coordinate-based
    // clicks (including force:true) still hit the backdrop. Use evaluate/el.click() to
    // dispatch directly to the element, bypassing z-index hit-testing.
    await page.getByTestId("date-switcher-yesterday").evaluate((el: HTMLElement) => el.click());
    await expect(page.getByTestId("walkin-queue-sidebar")).toHaveCount(0);
    await expect(page.getByTestId("status-pill")).toHaveCount(0);
    await expect(
      page.locator(
        '[data-testid="staff-timeline-grid"], [data-testid="vertical-day-view"]',
      ),
    ).toBeVisible();
  });

  test("case dt-2: walk-in queue visible again when viewing today", async ({ page }) => {
    const marker = testClientNameMarker();
    await seedWalkin(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
    });

    await gotoReceptionistCenter(page, fx.slug);
    await expect(
      page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });

    // evaluate/el.click() dispatches directly to the element, bypassing backdrop z-index
    await page.getByTestId("date-switcher-yesterday").evaluate((el: HTMLElement) => el.click());
    await expect(page.getByTestId("walkin-queue-sidebar")).toHaveCount(0);

    await page.getByTestId("date-switcher-today").evaluate((el: HTMLElement) => el.click());
    await expect(page.getByTestId("walkin-queue-sidebar")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("status-pill")).toBeVisible();
    await expect(
      page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
