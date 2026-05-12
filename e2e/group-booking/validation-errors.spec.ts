import { expect, test, type Page } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
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
    await pickDateInCalendar(page, nextOpenDateYmd());
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

  // BUG 2 (2026-05-12): the Confirm CTA is now disabled until the
  // basic contact-validity gate passes (phone ≥ 10 digits AND email
  // empty-or-valid). The pre-fix contract was "click → server
  // round-trip → error banner". The new contract is "button stays
  // disabled — user can't even fire the submit". Granular server-
  // side reasons (invalid_phone / invalid_email / etc., shipped in
  // PR #147) remain as a backstop if the client gate is ever
  // bypassed; we're not exercising that path here because it's not
  // reachable through normal UX.

  test("step 5: empty phone → Confirm stays disabled", async ({ page }) => {
    await walkToStep5(page);
    // No phone typed.
    await expect(page.getByTestId("group-confirm")).toBeDisabled();
  });

  test('step 5: phone "123" (under 10 digits) → Confirm stays disabled', async ({
    page,
  }) => {
    await walkToStep5(page);
    await page.getByTestId("group-primary-phone").fill("123");
    await expect(page.getByTestId("group-confirm")).toBeDisabled();
  });

  test('step 5: valid phone + invalid email → Confirm stays disabled', async ({
    page,
  }) => {
    await walkToStep5(page);
    await page.getByTestId("group-primary-phone").fill("+16045551234");
    await page.getByTestId("group-primary-email").fill("notanemail");
    await expect(page.getByTestId("group-confirm")).toBeDisabled();
  });

  test("step 5: valid phone + empty email → Confirm enables", async ({
    page,
  }) => {
    // Positive case so the disabled-only assertions above aren't
    // tautological. With a 10-digit NANP phone and no email, the
    // CTA should flip enabled. Email is optional so empty is OK.
    await walkToStep5(page);
    await page.getByTestId("group-primary-phone").fill("+16045551234");
    await expect(page.getByTestId("group-confirm")).toBeEnabled();
  });
});
