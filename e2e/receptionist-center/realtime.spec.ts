import { createHash } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { navigateToConfirmStep } from "../helpers/bookingFlow";
import {
  cleanupClientProfile,
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalonMember,
} from "../helpers/db";
import {
  cleanReceptionistData,
  clickWalkinService,
  clickWalkinSubmit,
  fillWalkinGuestContact,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;
let owner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;

async function loginAs(page: Page, account: { email: string; password: string }) {
  const digest = createHash("sha256").update(account.email).digest("hex");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
  });
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

function waitForRealtimeSubscription(page: Page, salonId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Realtime subscription did not acknowledge salon ${salonId}`));
    }, 15_000);

    page.on("websocket", (socket) => {
      if (!socket.url().includes("/realtime/v1/websocket")) return;
      socket.on("framereceived", ({ payload }) => {
        const frame = typeof payload === "string"
          ? payload
          : Buffer.from(payload).toString("utf8");
        if (
          frame.includes(`receptionist-center-${salonId}`) &&
          frame.includes('"phx_reply"') &&
          frame.includes('"status":"ok"')
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  });
}

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
  owner = await seedTestSalonMember(fx.salonId, "owner");
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
  if (owner) await cleanupTestUser(owner.userId);
});

/**
 * Case 3: Demo cookie sessions poll bookings every ~8s (no Supabase Realtime JWT).
 * We assert cross-tab consistency within polling window — not true realtime latency.
 */
test.describe("Cross-tab queue visibility", () => {
  test("case 3a: authenticated owner calendar receives a public booking within 5 seconds", async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Measured once on desktop Chromium; mobile layout is covered separately.");
    expect(owner, "authenticated owner fixture").toBeDefined();

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const ownerContext = await browser.newContext({ baseURL });
    const guestContext = await browser.newContext({ baseURL });
    const ownerPage = await ownerContext.newPage();
    const guestPage = await guestContext.newPage();
    let guestPhone: string | undefined;

    try {
      const marker = testClientNameMarker();
      guestPhone = `160455${String(Date.now() % 100_000).padStart(5, "0")}`;
      const guestDigest = createHash("sha256").update(marker).digest("hex");
      await guestPage.setExtraHTTPHeaders({
        "x-forwarded-for": `2001:db8::${guestDigest.slice(0, 4)}:${guestDigest.slice(4, 8)}`,
      });
      const { selectedDateYmd } = await navigateToConfirmStep(
        guestPage,
        fx.slug,
        { name: marker, phone: guestPhone },
      );

      const realtimeReady = waitForRealtimeSubscription(ownerPage, fx.salonId);
      await loginAs(ownerPage, owner!);
      await gotoReceptionistCenter(ownerPage, fx.slug, {
        dateYmd: selectedDateYmd,
        expectWalkinQueue: false,
        // Keep this journey genuinely authenticated. The default demo cookie
        // intentionally selects a service-role E2E path and would not prove
        // that a signed-in owner's Realtime JWT receives booking changes.
        useDemoCookie: false,
      });
      // A loaded page is not enough: wait for the Phoenix join acknowledgement
      // so the mutation cannot race the subscription handshake.
      await realtimeReady;

      const consent = guestPage.getByTestId("sms-consent");
      if (!(await consent.isChecked())) await consent.check();
      await guestPage.getByRole("button", { name: "Confirm booking" }).click();

      const success = guestPage.getByTestId("booking-success");
      const failure = guestPage.getByText(/Could not complete booking/i);
      await expect(success.or(failure).first()).toBeVisible({ timeout: 20_000 });
      await expect(failure, "public booking must be accepted before measuring calendar propagation").toHaveCount(0);
      await expect(success).toBeVisible();

      const acceptedAt = Date.now();
      const ownerBlock = ownerPage
        .locator('[data-testid^="booking-block-"]')
        .filter({ hasText: marker });
      await expect(ownerBlock).toBeVisible({ timeout: 5_000 });
      const propagationMs = Date.now() - acceptedAt;
      console.info(
        `[MQA-0023/MQA-0059] booking-success-to-owner-calendar=${propagationMs}ms sla=5000ms`,
      );
      expect(propagationMs, "public-booking success to authenticated owner calendar visibility").toBeLessThanOrEqual(5_000);
      await expect(ownerBlock).toHaveAttribute("data-booking-source", "appointment");
    } finally {
      await ownerContext.close();
      await guestContext.close();
      if (guestPhone) await cleanupClientProfile(guestPhone);
    }
  });

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
