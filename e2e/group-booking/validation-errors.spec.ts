import { expect, test, type Page } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  seedGroupTestSalon,
} from "./helpers";

const SLUG = "e2e-group-validation";

/**
 * Locks the validation contract laid down in the QA re-sweep
 * (PR #147):
 *
 *   - Step 2: empty name / missing service → `aria-invalid="true"`
 *     on the failing input + inline error message; step does NOT
 *     advance.
 *   - Step 5: empty phone → "phone required" copy.
 *   - Step 5: phone "123" → format error (not the generic
 *     "couldn't book" — that's the bug we fixed).
 *   - Step 5: malformed email → format error.
 */
test.describe("Group booking — validation errors", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("step 2: missing name + missing service → aria-invalid + step blocks", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG);
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();

    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });

    // Click Continue without filling anything.
    await page.getByTestId("group-service-next").click();

    // Still on step 2 (the panel didn't unmount).
    await expect(page.getByTestId("group-step-service-panel")).toBeVisible();

    // aria-invalid="true" on every offending field. Person 1 + 2
    // both empty → 4 invalid markers (2 names + 2 services).
    await expect(page.getByTestId("group-member-0-name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByTestId("group-member-0-service")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByTestId("group-member-1-name")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByTestId("group-member-1-service")).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    // role="alert" message visible — at least one per card, locale
    // independent regex (Vietnamese "vui lòng" or English "please").
    const alerts = page.getByRole("alert");
    expect(await alerts.count()).toBeGreaterThanOrEqual(2);
  });

  async function walkToStep5(page: Page): Promise<void> {
    await gotoGroupFlow(page, SLUG);
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Linh", 1, 2);
    await page.getByTestId("group-service-next").click();
    await page.getByTestId("group-date-input").fill(nextOpenDateYmd());
    await page.getByTestId("group-arrival-afternoon").click();
    await page.getByTestId("group-date-next").click();
    await page
      .getByTestId("group-arrangement-best")
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("group-arrangement-best").click();
    await page.getByTestId("group-arrangement-next").click();
    await page
      .getByTestId("group-step-confirm-panel")
      .waitFor({ state: "visible" });
  }

  test("step 5: empty phone → phone-required error", async ({ page }) => {
    await walkToStep5(page);
    // Leave phone blank; submit.
    await page.getByTestId("group-confirm").click();
    const err = page.getByTestId("group-error");
    await expect(err).toBeVisible();
    // EN copy: "Please enter a phone number."  VI copy: "Vui lòng nhập…".
    // Either way the string contains "phone" or "điện thoại".
    await expect(err).toHaveText(/phone|điện thoại/i);
  });

  test('step 5: phone "123" → format error, not generic server error', async ({
    page,
  }) => {
    await walkToStep5(page);
    await page.getByTestId("group-primary-phone").fill("123");
    await page.getByTestId("group-confirm").click();
    const err = page.getByTestId("group-error");
    await expect(err).toBeVisible();
    // Must mention "valid" or "không hợp lệ" — proves we hit the
    // client-side format check, not the catch-all server error.
    await expect(err).toHaveText(/valid|không hợp lệ|isn't valid/i);
    // Crucially must NOT be the generic "couldn't book the group"
    // banner — that was the pre-fix behavior we're locking out.
    await expect(err).not.toHaveText(/couldn't book|không đặt lịch nhóm/i);
  });

  test('step 5: email "notanemail" → email format error', async ({ page }) => {
    await walkToStep5(page);
    await page.getByTestId("group-primary-phone").fill("+16045551234");
    await page.getByTestId("group-primary-email").fill("notanemail");
    await page.getByTestId("group-confirm").click();
    const err = page.getByTestId("group-error");
    await expect(err).toBeVisible();
    await expect(err).toHaveText(/email/i);
  });
});
