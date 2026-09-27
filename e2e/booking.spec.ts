import { test, expect } from "@playwright/test";
import { withBookingSubmissionDiagnostics } from "./helpers/bookingSubmissionDiagnostics";

import {
  acceptSmsConsentIfPresented,
  cleanupTestSalon,
  gotoBookingServiceStep,
  seedTestSalon,
} from "./helpers/db";
import {
  advanceBookingStep,
  selectAvailableBookingDate,
} from "./helpers/bookingFlow";

test.describe("Booking Flow", () => {
  let testSlug: string;

  test.beforeEach(async () => {
    const { slug } = await seedTestSalon({
      phone: "15553334444",
      slug: "e2e-booking-salon",
      name: "E2E Booking Salon",
    });
    testSlug = slug;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("Complete booking end-to-end", async ({ page }) => {
    await withBookingSubmissionDiagnostics(page, test.info(), async () => {
      await gotoBookingServiceStep(page, testSlug);
      const configuredService = page
        .locator('[data-testid="service-tile-select"]')
        .first();
      await expect(configuredService).toContainText("Gel Manicure");
      await expect(configuredService).toContainText(/(?:CA)?\$45(?:\.00)?/);
      await configuredService.click();
      await page.getByRole("button", { name: "Continue" }).first().click();

      await page
        .locator('[data-testid="staff-item"]')
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
      await page.locator('[data-testid="staff-item"]').first().click();
      await page.getByRole("button", { name: "Continue" }).first().click();

      await selectAvailableBookingDate(page);
      await page.getByRole("button", { name: "Continue" }).first().click();

      const firstAvailableSlot = page
        .locator('[data-testid="time-slot"]:not([disabled])')
        .first();
      await expect(firstAvailableSlot).toBeVisible({ timeout: 20_000 });
      await firstAvailableSlot.click();
      await expect(firstAvailableSlot).toHaveAttribute("aria-pressed", "true");

      const timeStep = page.getByRole("group", { name: "Choose a time" });
      await advanceBookingStep(
        timeStep,
        page.getByTestId("booking-info-name"),
      );

      // Phone-first: the phone was captured at the entry gate, so the info step
      // only collects the name now.
      const clientName = page.getByTestId("booking-info-name");
      await clientName.fill("Test Client");
      await page.getByRole("button", { name: "Continue" }).first().click();

      await acceptSmsConsentIfPresented(page);
      await page.getByRole("button", { name: "Confirm booking" }).click();

      await expect(
        page.locator('[data-testid="booking-success"]'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/all set/i)).toBeVisible();
    });
  });

  test("Committed booking success does not wait for a held request-ID Web Lock", async ({ page, browserName }) => {
    test.skip(browserName !== "webkit", "The historical post-commit stall occurred in mobile WebKit");
    await withBookingSubmissionDiagnostics(page, test.info(), async () => {
      await gotoBookingServiceStep(page, testSlug);
      await page.locator('[data-testid="service-tile-select"]').first().click();
      await page.getByRole("button", { name: "Continue" }).first().click();
      await page.locator('[data-testid="staff-item"]').first().click();
      await page.getByRole("button", { name: "Continue" }).first().click();
      await selectAvailableBookingDate(page);
      await page.getByRole("button", { name: "Continue" }).first().click();
      await page.locator('[data-testid="time-slot"]:not([disabled])').first().click();
      await advanceBookingStep(
        page.getByRole("group", { name: "Choose a time" }),
        page.getByTestId("booking-info-name"),
      );
      await page.getByTestId("booking-info-name").fill("Test Client");
      await page.getByRole("button", { name: "Continue" }).first().click();
      await acceptSmsConsentIfPresented(page);

      const confirm = page.getByTestId("confirm-booking-btn");
      await expect(confirm).toBeEnabled();
      const requestLockHandle = await page.waitForFunction(() => {
        const keys = Object.keys(localStorage).filter((key) =>
          key.startsWith("nailiq:public-booking-request:v2:"),
        );
        return keys.length === 1 ? keys[0] : null;
      }, undefined, { timeout: 15_000 });
      const lockName = await requestLockHandle.jsonValue() as string;
      await requestLockHandle.dispose();

      // Reproduce the browser-side stall from the failed CI trace without
      // modifying booking requests or the synthetic salon. Old code awaited
      // this lock after the server committed and never showed Success.
      const acquired = await page.evaluate(async (name) => {
        if (!navigator.locks || !name) return false;
        let markAcquired = (): void => undefined;
        const acquiredPromise = new Promise<void>((resolve) => { markAcquired = resolve; });
        let release = (): void => undefined;
        const heldPromise = new Promise<void>((resolve) => { release = resolve; });
        const qaWindow = window as Window & {
          __releaseBookingQaLock?: () => void;
          __bookingQaLockHeld?: boolean;
        };
        qaWindow.__releaseBookingQaLock = release;
        void navigator.locks.request(name, async () => {
          qaWindow.__bookingQaLockHeld = true;
          markAcquired();
          await heldPromise;
          qaWindow.__bookingQaLockHeld = false;
        }).catch(() => undefined);
        await acquiredPromise;
        return true;
      }, lockName);
      expect(acquired, "Web Locks must be available in this WebKit run").toBe(true);

      try {
        await confirm.click();
        await expect(page.getByTestId("booking-success")).toBeVisible({ timeout: 15_000 });
        await expect(page.getByText(/all set/i)).toBeVisible();
        expect(await page.evaluate(() =>
          (window as Window & { __bookingQaLockHeld?: boolean }).__bookingQaLockHeld,
        )).toBe(true);
      } finally {
        await page.evaluate(() => {
          const qaWindow = window as Window & { __releaseBookingQaLock?: () => void };
          qaWindow.__releaseBookingQaLock?.();
          delete qaWindow.__releaseBookingQaLock;
        }).catch(() => undefined);
      }
    });
  });

  test("Time step lists slots for a future day", async ({ page }) => {
    await gotoBookingServiceStep(page, testSlug);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="staff-item"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-testid="staff-item"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    await selectAvailableBookingDate(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    const slots = page.locator('[data-testid="time-slot"]');
    await expect(slots.first()).toBeVisible({ timeout: 20_000 });
    expect(await slots.count()).toBeGreaterThan(0);

    const raw = (await slots.first().textContent())?.trim() ?? "";
    expect(raw).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
  });

  test("Calendar shows today and selectable days", async ({ page }) => {
    await gotoBookingServiceStep(page, testSlug);
    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();
    await page
      .locator('[data-testid="any-staff-option"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-testid="any-staff-option"]').click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    // The near-term strip shows first (#593); open the full month grid to
    // exercise month navigation + the today marker.
    await page.locator('[data-testid="date-toggle-calendar"]').click();
    // The calendar opens on the first month that has availability, so there is
    // always at least one selectable day on arrival. On the last day of the
    // month that day can be today, which intentionally uses `date-today`
    // instead of `date-day`.
    await expect(
      page
        .locator(
          '[data-testid="date-day"]:not([disabled]), [data-testid="date-today"]:not([disabled])',
        )
        .first(),
    ).toBeVisible();
    // "Today" carries its own marker (`date-today`). When today's month has no
    // availability (today closed, or the last day of the month) the calendar
    // opens on a later month, so today may be one or more months back. Step back
    // until it appears or the prev-month control bottoms out — today is always
    // reachable from the calendar even if it isn't the default view.
    const todayCell = page.locator('[data-testid="date-today"]');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await todayCell.isVisible().catch(() => false)) break;
      const prev = page.locator('[data-testid="calendar-prev-month"]');
      if (!(await prev.isEnabled().catch(() => false))) break;
      await prev.click();
      await page.waitForTimeout(300);
    }
    await expect(todayCell).toBeVisible();
  });
});
