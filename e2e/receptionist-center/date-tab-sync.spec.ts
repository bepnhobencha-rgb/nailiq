import { test, expect } from "./test";

import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  seedWalkin,
  testClientNameMarker,
} from "./helpers";

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

test.describe("date-tab-sync", () => {
  test("case dt-1: walk-in queue hidden when viewing yesterday", async ({ page, rcFixture }) => {
    const marker = testClientNameMarker();
    await seedWalkin(rcFixture.salonId, {
      clientName: marker,
      serviceId: rcFixture.serviceIds[0]!,
    });

    await gotoReceptionistCenter(page, rcFixture.slug);
    await expect(page.getByTestId("walkin-queue-sidebar")).toBeVisible();
    await expect(
      page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("date-switcher-yesterday").click();
    await expect(page.getByTestId("walkin-queue-sidebar")).toHaveCount(0);
    await expect(page.getByTestId("status-pill")).toHaveCount(0);
    await expect(page.getByTestId("staff-timeline-grid")).toBeVisible();
  });

  test("case dt-2: walk-in queue visible again when viewing today", async ({ page, rcFixture }) => {
    const marker = testClientNameMarker();
    await seedWalkin(rcFixture.salonId, {
      clientName: marker,
      serviceId: rcFixture.serviceIds[0]!,
    });

    await gotoReceptionistCenter(page, rcFixture.slug);
    await expect(
      page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });

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
