import { expect, type Page } from "@playwright/test";

import { gotoBookingServiceStep } from "./db";

/**
 * Drive the public booking flow to the confirm step.
 *
 * Lifted from the private helpers in booking-errors.spec.ts rather than
 * reimplemented — the navigation is genuinely fiddly (the month grid hides behind
 * a toggle, "today" renders as `date-today` not `date-day`, and late in the month
 * you may have to advance a month to find a selectable day), and a smoke gate
 * that guesses at it goes red for reasons that have nothing to do with the
 * product. booking-errors.spec.ts is left untouched: refactoring a passing spec
 * to share code is churn this change does not need.
 */
export async function navigateToConfirmStep(
  page: Page,
  slug: string,
  opts?: { name?: string; notes?: string },
): Promise<void> {
  // 1. Phone-first gate → service step.
  await gotoBookingServiceStep(page, slug);

  // 2. Service.
  await page
    .locator('[data-testid="service-tile-select"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="service-tile-select"]').first().click();
  await page.getByRole("button", { name: "Continue" }).first().click();

  // 3. Staff.
  await page
    .locator('[data-testid="staff-item"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="staff-item"]').first().click();
  await page.getByRole("button", { name: "Continue" }).first().click();

  // 4. Date. The month grid is collapsed behind a toggle; open it, then walk
  //    forward until a selectable day appears.
  await page
    .locator('[data-testid="date-toggle-calendar"]')
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="date-toggle-calendar"]').click();
  await page
    .locator('[data-testid="calendar-grid"]')
    .waitFor({ state: "visible", timeout: 15_000 });

  const selectableDay = page
    .locator('[data-testid="date-day"]:not([disabled])')
    .first();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await selectableDay.waitFor({ state: "visible", timeout: 5_000 });
      break;
    } catch {
      const next = page.locator('[data-testid="calendar-next-month"]');
      if (!(await next.isEnabled().catch(() => false))) break;
      await next.click();
    }
  }
  await selectableDay.waitFor({ state: "visible", timeout: 15_000 });
  await selectableDay.click();
  await expect(selectableDay).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continue" }).first().click();

  // 5. Time.
  await page
    .locator('[data-testid="time-slot"]:not([disabled])')
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  await page
    .locator('[data-testid="time-slot"]:not([disabled])')
    .first()
    .click();
  await page.getByRole("button", { name: "Continue" }).first().click();

  // 6. Info (phone was captured at the gate; this step takes the name).
  await page
    .getByTestId("booking-info-name")
    .fill(opts?.name ?? "Smoke Guest");
  if (opts?.notes) {
    const notes = page.locator(
      'textarea[name="clientNotes"], textarea[data-testid="booking-info-notes"]',
    );
    if ((await notes.count()) > 0) await notes.first().fill(opts.notes);
  }
  await page.getByRole("button", { name: "Continue" }).first().click();

  await expect(
    page.getByRole("button", { name: "Confirm booking" }),
  ).toBeVisible({ timeout: 15_000 });
}
