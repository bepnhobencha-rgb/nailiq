import { expect, type Locator, type Page } from "@playwright/test";

import { gotoBookingServiceStep } from "./db";

/**
 * Advance one animated booking step and prove the destination mounted.
 *
 * Under saturated CI workers Chromium can occasionally report a completed
 * pointer click without React receiving it. Retrying blindly is unsafe because
 * a delayed first click could advance two steps. We therefore retry only while
 * the original panel and CTA are still visible. A second miss remains a hard
 * failure.
 */
export async function advanceBookingStep(
  sourcePanel: Locator,
  destination: Locator,
): Promise<void> {
  const continueButton = sourcePanel.getByRole("button", {
    name: "Continue",
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    try {
      await destination.waitFor({ state: "visible", timeout: 3_000 });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      await expect(sourcePanel).toBeVisible();
      await expect(continueButton).toBeEnabled();
    }
  }
}

/**
 * Reveal the month grid and choose a future, selectable booking date.
 *
 * Do not select a fixed ordinal such as `.nth(1)`: at the end of a month the
 * current grid can legitimately contain only one future day. If this month has
 * none, walk forward until the booking window exposes one.
 */
export async function selectAvailableBookingDate(page: Page): Promise<string> {
  const dateStep = page.locator(
    'section[aria-labelledby="date-heading"]',
  );
  const calendarGrid = dateStep.getByTestId("calendar-grid");

  if (!(await calendarGrid.isVisible().catch(() => false))) {
    await dateStep.getByTestId("date-toggle-calendar").click();
  }
  await calendarGrid.waitFor({ state: "visible", timeout: 15_000 });

  const selectableDay = dateStep
    .locator('[data-testid="date-day"]:not([disabled])')
    .first();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let found = false;
    try {
      await selectableDay.waitFor({ state: "visible", timeout: 3_000 });
      found = true;
    } catch {
      // This month has no selectable future date.
    }

    if (found) {
      await selectableDay.click();
      await expect(selectableDay).toHaveAttribute("aria-pressed", "true");
      const selectedDateYmd = await selectableDay.getAttribute("data-ymd");
      if (!selectedDateYmd) {
        throw new Error("Selected booking date is missing data-ymd");
      }
      return selectedDateYmd;
    }

    const nextMonth = dateStep.getByTestId("calendar-next-month");
    if (!(await nextMonth.isEnabled().catch(() => false))) break;
    await nextMonth.click();
  }

  await expect(
    selectableDay,
    "Expected a selectable future date within the booking window",
  ).toBeVisible({ timeout: 15_000 });
  await selectableDay.click();
  await expect(selectableDay).toHaveAttribute("aria-pressed", "true");
  const selectedDateYmd = await selectableDay.getAttribute("data-ymd");
  if (!selectedDateYmd) {
    throw new Error("Selected booking date is missing data-ymd");
  }
  return selectedDateYmd;
}

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
  opts?: { name?: string; notes?: string; phone?: string },
): Promise<{ selectedDateYmd: string; selectedSlotAriaLabel: string }> {
  // 1. Phone-first gate → service step.
  await gotoBookingServiceStep(page, slug, {
    phone: opts?.phone,
  });

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
  const selectedDateYmd = await selectAvailableBookingDate(page);
  await page.getByRole("button", { name: "Continue" }).first().click();

  // 5. Time.
  await page
    .locator('[data-testid="time-slot"]:not([disabled])')
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  const firstAvailableSlot = page
    .locator('[data-testid="time-slot"]:not([disabled])')
    .first();
  await firstAvailableSlot.click();
  await expect(firstAvailableSlot).toHaveAttribute("aria-pressed", "true");
  const selectedSlotAriaLabel = await firstAvailableSlot.getAttribute("aria-label");
  if (!selectedSlotAriaLabel) {
    throw new Error("Selected booking slot is missing aria-label");
  }
  const timeStep = page.locator(
    'section[aria-labelledby="time-heading"]',
  );
  await advanceBookingStep(
    timeStep,
    page.getByTestId("booking-info-name"),
  );

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

  return { selectedDateYmd, selectedSlotAriaLabel };
}
