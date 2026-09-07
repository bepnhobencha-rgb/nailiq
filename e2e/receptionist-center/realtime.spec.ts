import { createHash } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import { navigateToConfirmStep } from "../helpers/bookingFlow";
import {
  acceptSmsConsentIfPresented,
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
  seedDeskBooking,
  supabaseAdmin,
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
  await page.getByTestId("password-signin-submit").click();
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

async function findBookingByClientName(clientName: string): Promise<{
  id: string;
  startTimeUtc: string;
  endTimeUtc: string;
}> {
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("id, start_time_utc, end_time_utc")
    .eq("salon_id", fx.salonId)
    .eq("client_name", clientName)
    .single();

  if (error || !data?.id || !data.start_time_utc || !data.end_time_utc) {
    throw new Error(error?.message ?? `Booking not found for ${clientName}`);
  }

  return {
    id: String(data.id),
    startTimeUtc: new Date(String(data.start_time_utc)).toISOString(),
    endTimeUtc: new Date(String(data.end_time_utc)).toISOString(),
  };
}

async function rescheduleBooking(
  booking: { id: string; startTimeUtc: string; endTimeUtc: string },
  shiftMinutes: number,
): Promise<void> {
  const shiftMs = shiftMinutes * 60_000;
  const { error } = await supabaseAdmin
    .from("bookings")
    .update({
      staff_id: fx.freeStaffId,
      start_time_utc: new Date(Date.parse(booking.startTimeUtc) + shiftMs).toISOString(),
      end_time_utc: new Date(Date.parse(booking.endTimeUtc) + shiftMs).toISOString(),
    })
    .eq("salon_id", fx.salonId)
    .eq("id", booking.id);
  if (error) throw new Error(`rescheduleBooking: ${error.message}`);
}

async function cancelBooking(bookingId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("salon_id", fx.salonId)
    .eq("id", bookingId);
  if (error) throw new Error(`cancelBooking: ${error.message}`);
}

async function blockLeftPx(page: Page, bookingId: string): Promise<number> {
  return await page.getByTestId(`booking-block-${bookingId}`).evaluate((element) => {
    return Number.parseFloat((element as HTMLElement).style.left);
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
  test("case 3a: authenticated owner calendar receives public create, reschedule, and cancel mutations", async ({
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

      await acceptSmsConsentIfPresented(guestPage);
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

      const booking = await findBookingByClientName(marker);
      const oldLeftPx = await blockLeftPx(ownerPage, booking.id);
      await rescheduleBooking(booking, 30);
      await expect
        .poll(() => blockLeftPx(ownerPage, booking.id), {
          timeout: 5_000,
          message: "Realtime should remove the old slot and render the rescheduled slot",
        })
        .not.toBe(oldLeftPx);

      await cancelBooking(booking.id);
      await expect(ownerPage.getByTestId(`booking-block-${booking.id}`)).toHaveCount(0, {
        timeout: 5_000,
      });
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

  test("case 3b: authenticated owner polling fallback receives create, reschedule, and cancel", async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Measured once on desktop Chromium; mobile layout is covered separately.");
    expect(owner, "authenticated owner fixture").toBeDefined();

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const ownerContext = await browser.newContext({ baseURL });
    const ownerPage = await ownerContext.newPage();

    try {
      await ownerPage.routeWebSocket(/realtime\/v1\/websocket/, (ws) => {
        ws.close();
      });
      await loginAs(ownerPage, owner!);
      await gotoReceptionistCenter(ownerPage, fx.slug, {
        dateYmd: fx.ymdUtc,
        expectWalkinQueue: false,
        useDemoCookie: false,
      });

      const failedStateBanner = ownerPage.locator(
        '[data-testid="connection-banner-offline"], [data-testid="connection-banner-reconnecting"]',
      );
      await expect(failedStateBanner.first()).toBeVisible({ timeout: 15_000 });

      const marker = testClientNameMarker();
      const bookingId = await seedDeskBooking(fx.salonId, {
        clientName: marker,
        serviceId: fx.serviceIds[0]!,
        staffId: fx.freeStaffId,
        startIso: new Date(`${fx.ymdUtc}T13:00:00.000Z`).toISOString(),
        endIso: new Date(`${fx.ymdUtc}T13:55:00.000Z`).toISOString(),
        status: "confirmed",
      });
      const block = ownerPage.getByTestId(`booking-block-${bookingId}`);
      await expect(block).toBeVisible({ timeout: 12_000 });

      const booking = await findBookingByClientName(marker);
      const oldLeftPx = await blockLeftPx(ownerPage, bookingId);
      await rescheduleBooking(booking, 30);
      await expect
        .poll(() => blockLeftPx(ownerPage, bookingId), {
          timeout: 12_000,
          message: "Polling fallback should remove the old slot and render the rescheduled slot",
        })
        .not.toBe(oldLeftPx);

      await cancelBooking(bookingId);
      await expect(block).toHaveCount(0, { timeout: 12_000 });
    } finally {
      await ownerContext.close();
    }
  });
});
