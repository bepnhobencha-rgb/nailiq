import { test, expect } from "./test";

import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  seedWalkin,
} from "./helpers";

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

test.describe("Walk-in urgency", () => {
  test("case 10: old joined_queue_at shows urgent badge", async ({ page, rcFixture }) => {
    const marker = `Te2eUrgent${Date.now()}`;
    const oldJoined = new Date(Date.now() - 21 * 60_000).toISOString();

    await seedWalkin(rcFixture.salonId, {
      clientName: marker,
      serviceId: rcFixture.serviceIds[0]!,
      joinedQueueAtIso: oldJoined,
    });

    await gotoReceptionistCenter(page, rcFixture.slug);

    const row = page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(/URGENT|VỘI/);
  });
});
