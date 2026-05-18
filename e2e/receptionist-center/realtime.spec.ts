import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  clickWalkinService,
  clickWalkinSubmit,
  fillWalkinGuestContact,
  gotoReceptionistCenter,
  RECEPTIONIST_E2E_SLUG,
  seedReceptionistCenterFixture,
  testClientNameMarker,
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

/**
 * Case 3: Demo cookie sessions poll bookings every ~8s (no Supabase Realtime JWT).
 * We assert cross-tab consistency within polling window — not true realtime latency.
 */
test.describe("Cross-tab queue visibility", () => {
  test("case 3: second tab observes walk-in within polling window", async ({ browser }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    let hostname = "localhost";
    try {
      hostname = new URL(baseURL).hostname;
    } catch {
      /* noop */
    }

    const cookie = {
      name: "nailiq-demo-slug",
      value: fx.slug,
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
      await gotoReceptionistCenter(leader, fx.slug);
      await gotoReceptionistCenter(follower, fx.slug);

      const marker = testClientNameMarker();

      await fillWalkinGuestContact(leader, marker);
      await clickWalkinService(leader, fx.serviceIds[0]!);
      await clickWalkinSubmit(leader);

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
