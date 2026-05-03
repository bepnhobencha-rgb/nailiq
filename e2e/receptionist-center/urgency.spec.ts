import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  RECEPTIONIST_E2E_SLUG,
  seedReceptionistCenterFixture,
  seedWalkin,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

test.beforeAll(async () => {
  fx = await seedReceptionistCenterFixture();
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async () => {
  await cleanupTestSalon(RECEPTIONIST_E2E_SLUG);
});

test.describe("Walk-in urgency", () => {
  test("case 10: old joined_queue_at shows urgent badge", async ({ page }) => {
    const marker = `TEST_E2E_urgent_${Date.now()}`;
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
