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

    // On mobile the queue is a slide-over drawer; close it so the date switcher is clickable
    const backdrop1 = page.getByTestId("queue-panel-backdrop");
    if ((await backdrop1.count()) > 0) {
      await backdrop1.click({ force: true });
    }

    await page.getByTestId("date-switcher-yesterday").click();
    await expect(page.getByTestId("walkin-queue-sidebar")).toHaveCount(0);
    await expect(page.getByTestId("status-pill")).toHaveCount(0);
    await expect(page.getByTestId("staff-timeline-grid")).toBeVisible();
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

    // On mobile the queue is a slide-over drawer; close it so the date switcher is clickable
    const backdrop2 = page.getByTestId("queue-panel-backdrop");
    if ((await backdrop2.count()) > 0) {
      await backdrop2.click({ force: true });
    }

    await page.getByTestId("date-switcher-yesterday").click();
    await expect(page.getByTestId("walkin-queue-sidebar")).toHaveCount(0);

    await page.getByTestId("date-switcher-today").click();
    await expect(page.getByTestId("walkin-queue-sidebar")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("status-pill")).toBeVisible();
    await expect(
      page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
