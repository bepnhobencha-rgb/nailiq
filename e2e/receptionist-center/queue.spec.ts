import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  clickAssignSlot,
  clickWalkinQueueAssign,
  clickWalkinService,
  clickWalkinSubmit,
  countBookingsForClient,
  fillWalkinGuestContact,
  getBookingRow,
  gotoReceptionistCenter,
  RECEPTIONIST_E2E_SLUG,
  seedReceptionistCenterFixture,
  seedWalkin,
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

test.describe("Receptionist queue + assign", () => {
  test("case 1: add walk-in via form — queue item + status pill waiting count", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, fx.slug);
    const marker = testClientNameMarker();

    await fillWalkinGuestContact(page, marker);
    await clickWalkinService(page, fx.serviceIds[0]!);
    await clickWalkinSubmit(page);

    await expect(
      page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });

    const pill = page.getByTestId("status-pill");
    await expect(pill).toContainText(/\b1\b/);
    await expect(pill).toHaveAttribute("data-state", /^(calm|default|busy)$/);
    await expect(page.getByTestId("walkin-add-form").locator('input[type="text"]').first()).toHaveValue(
      "",
    );
    await expect(page.getByTestId("walkin-phone")).toHaveValue("");
  });

  test("case 2: assign walk-in — grid block + queue cleared + undo toast", async ({ page }) => {
    await gotoReceptionistCenter(page, fx.slug);
    const marker = testClientNameMarker();

    await fillWalkinGuestContact(page, marker);
    await clickWalkinService(page, fx.serviceIds[0]!);
    await clickWalkinSubmit(page);

    const row = page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const testId = await row.getAttribute("data-testid");
    const bookingId = testId?.replace(/^queue-item-/, "") ?? "";
    expect(bookingId.length).toBeGreaterThan(10);

    await page.getByTestId(`queue-assign-${bookingId}`).click();

    await clickAssignSlot(page, fx.freeStaffId, fx.noonSlotIndex);

    await expect(
      page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker }),
    ).toHaveCount(0, { timeout: 15_000 });

    await expect(page.getByTestId(`booking-block-${bookingId}`)).toBeVisible({ timeout: 15_000 });

    const assignedBtn = page.getByTestId(`booking-block-${bookingId}`);
    await expect(assignedBtn).toBeVisible();

    await expect(page.getByTestId("undo-toast")).toBeVisible({ timeout: 15_000 });

    const rowAfter = await getBookingRow(fx.salonId, bookingId);
    expect(rowAfter?.status).toBe("confirmed");
  });

  test("case 4: parallel assign — single confirmed row for walk-in id", async ({ browser }) => {
    const marker = testClientNameMarker();
    const bookingId = await seedWalkin(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
    });

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

    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    try {
      await gotoReceptionistCenter(p1, fx.slug);
      await gotoReceptionistCenter(p2, fx.slug);

      await expect(p1.getByTestId(`queue-item-${bookingId}`)).toBeVisible({ timeout: 15_000 });
      await expect(p2.getByTestId(`queue-item-${bookingId}`)).toBeVisible({ timeout: 15_000 });

      await clickWalkinQueueAssign(p1, bookingId);
      await clickWalkinQueueAssign(p2, bookingId);

      await expect(p1.getByTestId("walkin-assign-active-hint")).toBeVisible({ timeout: 15_000 });
      await expect(p2.getByTestId("walkin-assign-active-hint")).toBeVisible({ timeout: 15_000 });
      await expect(p1.getByTestId("staff-timeline-grid")).toHaveClass(/cursor-copy/, { timeout: 15_000 });
      await expect(p2.getByTestId("staff-timeline-grid")).toHaveClass(/cursor-copy/, { timeout: 15_000 });

      const slotClick = async (p: import("@playwright/test").Page) => {
        await clickAssignSlot(p, fx.freeStaffId, fx.noonSlotIndex);
      };
      /** Stagger so both contexts hit assign close together without identical millisecond timestamps. */
      await Promise.all([slotClick(p1), (async () => { await p2.waitForTimeout(120); await slotClick(p2); })()]);

      await expect
        .poll(async () => countBookingsForClient(fx.salonId, marker))
        .toBe(1);

      await expect
        .poll(async () => (await getBookingRow(fx.salonId, bookingId))?.status, { timeout: 15_000 })
        .toBe("confirmed");
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});
