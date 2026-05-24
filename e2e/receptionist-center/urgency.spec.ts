import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  seedWalkin,
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

test.describe("Walk-in urgency", () => {
  test("case 10: old joined_queue_at shows urgent badge", async ({ page }) => {
    const marker = `Te2eUrgent${Date.now()}`;
    const oldJoined = new Date(Date.now() - 21 * 60_000).toISOString();

    await seedWalkin(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
      joinedQueueAtIso: oldJoined,
    });

    await gotoReceptionistCenter(page, fx.slug);

    const row = page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(/URGENT|VỘI/);
  });
});
