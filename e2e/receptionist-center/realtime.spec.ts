import { test, expect } from "./test";

import {
  cleanReceptionistData,
  fillWalkinGuestContact,
  gotoReceptionistCenter,
  testClientNameMarker,
} from "./helpers";

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

/**
 * Case 3: Demo cookie sessions poll bookings every ~8s (no Supabase Realtime JWT).
 * We assert cross-tab consistency within polling window — not true realtime latency.
 */
test.describe("Cross-tab queue visibility", () => {
  test("case 3: second tab observes walk-in within polling window", async ({ browser, rcFixture }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    let hostname = "localhost";
    try {
      hostname = new URL(baseURL).hostname;
    } catch {
      /* noop */
    }

    const cookie = {
      name: "nailiq-demo-slug",
      value: rcFixture.slug,
      domain: hostname === "127.0.0.1" ? "127.0.0.1" : hostname === "localhost" ? "localhost" : hostname,
      path: "/" as const,
    };

    const ctx1 = await browser.newContext({ baseURL });
    const ctx2 = await browser.newContext({ baseURL });
    await ctx1.addCookies([cookie]);
    await ctx2.addCookies([cookie]);

    const leader = await ctx1.newPage();
    const follower = await ctx2.newPage();

    try {
      await gotoReceptionistCenter(leader, rcFixture.slug);
      await gotoReceptionistCenter(follower, rcFixture.slug);

      const marker = testClientNameMarker();

      await fillWalkinGuestContact(leader, marker);
      await leader.locator(`#walkin-service-${rcFixture.serviceIds[0]}`).click();
      await leader.getByTestId("walkin-add-form").locator('button[type="submit"]').click();

      await expect(
        leader.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
      ).toBeVisible({ timeout: 15_000 });

      await expect(
        follower.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
      ).toBeVisible({ timeout: 14_000 });
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
