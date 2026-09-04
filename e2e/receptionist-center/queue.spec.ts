import { createHash } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalonMember,
} from "../helpers/db";
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
  rcSlug,
  seedReceptionistCenterFixture,
  seedWalkin,
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

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
  owner = await seedTestSalonMember(fx.salonId, "owner");
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async ({}, testInfo) => {
  try {
    await cleanupTestSalon(rcSlug(testInfo.project.name));
  } finally {
    if (owner) await cleanupTestUser(owner.userId);
  }
});

test.describe("Receptionist queue + assign", () => {
  test("desktop queue panel reserves the header instead of covering its actions", async ({
    page,
  }) => {
    if (!owner) throw new Error("receptionist owner fixture missing");
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedWalkin(fx.salonId, {
      clientName: testClientNameMarker(),
      serviceId: fx.serviceIds[0]!,
    });
    await loginAs(page, owner);
    await gotoReceptionistCenter(page, fx.slug, { useDemoCookie: false });

    const panel = page.getByTestId("queue-panel-slideover");
    const toggle = page.getByTestId("queue-panel-toggle");
    // Start from a deliberate closed state so a default-open hydration effect
    // cannot race the geometry assertion.
    if ((await panel.getAttribute("aria-hidden")) === "false") {
      await toggle.click();
      await expect(panel).toHaveAttribute("aria-hidden", "true");
    }
    await page.getByTestId("header-add-walkin").click();
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    await expect(panel).toHaveClass(/translate-x-0/);
    await page.waitForTimeout(350);
    await expect(panel).toHaveAttribute("aria-hidden", "false");

    const header = page.getByTestId("receptionist-center-header");
    const actions = page.getByTestId("receptionist-header-actions");
    const [panelBox, actionsBox, paddingRight] = await Promise.all([
      panel.boundingBox(),
      actions.boundingBox(),
      header.evaluate((element) => getComputedStyle(element).paddingRight),
    ]);
    expect(panelBox, "queue panel must have measurable geometry").not.toBeNull();
    expect(actionsBox, "header actions must have measurable geometry").not.toBeNull();
    expect(Number.parseFloat(paddingRight)).toBeGreaterThanOrEqual(320);
    expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(panelBox!.x + 1);
  });

  test("critical queue actions keep 44px touch targets on a phone", async ({
    page,
  }) => {
    if (!owner) throw new Error("receptionist owner fixture missing");
    await page.setViewportSize({ width: 390, height: 844 });
    const bookingId = await seedWalkin(fx.salonId, {
      clientName: testClientNameMarker(),
      serviceId: fx.serviceIds[0]!,
    });

    await loginAs(page, owner);
    await gotoReceptionistCenter(page, fx.slug, { useDemoCookie: false });

    for (const action of ["cancel", "assign"] as const) {
      const target = page.getByTestId(`queue-${action}-${bookingId}`);
      await expect(target).toBeVisible({ timeout: 15_000 });
      const box = await target.boundingBox();
      expect(box, `${action} action must have measurable geometry`).not.toBeNull();
      expect(box!.height, `${action} action must be at least 44px tall`).toBeGreaterThanOrEqual(44);
    }
  });

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

    // Queue item can appear via realtime before submit promise resolves; wait
    // for form reset. The submit button swaps to its submitting label while the
    // add-walkin server action is in flight and only restores `walkin-submit-label`
    // once submitting flips back to false — the same tick the form clears its
    // inputs. Gating on it avoids asserting the reset too early on a slow CI server.
    await expect(page.getByTestId("walkin-submit-label")).toBeVisible({ timeout: 15_000 });
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
    if ((page.viewportSize()?.width ?? 1280) < 640) {
      await expect(page.getByTestId("queue-panel-slideover")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
      await expect(page.getByTestId("mobile-walkin-assign-banner")).toBeVisible();
    }

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

      const assignHint = (p: import("@playwright/test").Page) =>
        p.getByTestId(
          (p.viewportSize()?.width ?? 0) < 768
            ? "mobile-walkin-assign-banner"
            : "walkin-assign-active-hint",
        );
      await expect(assignHint(p1)).toBeVisible({ timeout: 15_000 });
      await expect(assignHint(p2)).toBeVisible({ timeout: 15_000 });
      const assignSurface = (p: import("@playwright/test").Page) =>
        p.locator(
          '[data-testid="staff-timeline-grid"], [data-testid="vertical-day-view"]',
        );
      await expect(assignSurface(p1)).toHaveClass(/cursor-copy/, { timeout: 15_000 });
      await expect(assignSurface(p2)).toHaveClass(/cursor-copy/, { timeout: 15_000 });

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

  test("case 5: empty name blocks submit — error + focus, no queue item, no undo toast", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, fx.slug);
    await clickWalkinService(page, fx.serviceIds[0]!);
    const queueItem = page.locator('[data-testid^="queue-item-"]');
    const beforeCount = await queueItem.count();
    await clickWalkinSubmit(page);

    const form = page.getByTestId("walkin-add-form");
    // Client validation blocks the submit: the required-name error is shown.
    await expect(form.getByTestId("walkin-name-error")).toBeVisible();
    // No success/undo toast — it stays hidden/inert (never opens on a blocked
    // submit). The toast node is always mounted, so assert it's not active.
    await expect(page.getByTestId("undo-toast")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    // No NEW walk-in created by the blocked submit.
    await expect(queueItem).toHaveCount(beforeCount);
    // (Focus returns to the name field via runSubmit's queueMicrotask focus —
    // correct for real users; not asserted here because the helper's synthetic
    // el.click() can't establish the focus context a real click does.)
  });

  test("actual arrival time reports an invalid correction immediately and blocks submit", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, fx.slug);
    await fillWalkinGuestContact(page, testClientNameMarker());
    await clickWalkinService(page, fx.serviceIds[0]!);

    const form = page.getByTestId("walkin-add-form");
    const actualTime = form.getByTestId("walkin-actual-time");
    const currentHm = await actualTime.inputValue();
    const [hours, minutes] = currentHm.split(":").map(Number);
    const currentMinutes = hours * 60 + minutes;
    const tooOldMinutes = (currentMinutes - 31 + 24 * 60) % (24 * 60);
    const tooOldHm = `${String(Math.floor(tooOldMinutes / 60)).padStart(2, "0")}:${String(tooOldMinutes % 60).padStart(2, "0")}`;

    await actualTime.fill(tooOldHm);
    await expect(form.getByTestId("walkin-actual-time-error")).toBeVisible();
    await expect(form.getByTestId("walkin-submit")).toBeDisabled();

    await actualTime.fill(currentHm);
    await expect(form.getByTestId("walkin-actual-time-error")).toHaveCount(0);
    await expect(form.getByTestId("walkin-submit")).toBeEnabled();
  });

  test("case 6: double-click submit — only one walk-in created (in-flight guard)", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, fx.slug);
    const marker = testClientNameMarker();
    await fillWalkinGuestContact(page, marker);
    await clickWalkinService(page, fx.serviceIds[0]!);

    // Two synchronous clicks in one tick — the in-flight ref must drop the
    // 2nd before the button's `disabled={submitting}` has re-rendered.
    const submit = page.locator('[data-testid="walkin-submit"]:not([disabled])');
    await submit.waitFor({ state: "attached", timeout: 15_000 });
    await submit.evaluate((el: HTMLElement) => {
      el.click();
      el.click();
    });

    await expect(
      page.locator('[data-testid^="queue-item-"]').filter({ hasText: marker }),
    ).toBeVisible({ timeout: 15_000 });
    // Exactly one booking for this client — the 2nd click created nothing.
    await expect
      .poll(async () => countBookingsForClient(fx.salonId, marker))
      .toBe(1);
  });
});
