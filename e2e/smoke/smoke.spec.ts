import { test, expect } from "@playwright/test";

import {
  cleanupTestSalon,
  gotoBookingServiceStep,
  seedTestSalon,
} from "../helpers/db";

/**
 * The gate. Small, fast, and every assertion here is one that must NEVER be red.
 *
 * The full suite is 200 tests and 50 of them fail — all pre-existing, none caused
 * by the harness (see docs/audit/E2E-FIRST-FULL-RUN.md, issues #746-#749). A
 * backlog that size cannot be a merge gate: it would block every unrelated PR
 * from day one, and the first thing anyone would do is learn to ignore it. A
 * required check people ignore is worse than no required check, because it looks
 * like protection.
 *
 * So this file is the required check, and it holds only flows that are proven
 * stable — every assertion below is drawn from a test that passed on BOTH shards
 * of the first full run, or is a plain HTTP fact.
 *
 * ── What is deliberately NOT here, and why ──────────────────────────────────
 *
 * A COMPLETED public booking. It ought to be the centrepiece of a smoke gate,
 * and it cannot be: submitting the public booking form currently fails with
 * "Could not complete booking. Please try again." (#746). That failure is
 * pre-existing and is NOT the harness — the create_public_booking RPC was called
 * directly against this exact baseline and returned
 * `{"success": true, "booking_id": ...}`, and submitPublicBooking reads no
 * environment variable that could throw.
 *
 * Putting a known-failing flow in a required gate would make the gate
 * permanently red, which teaches everyone to bypass it. So the gate goes as far
 * as the product reliably goes today — through the phone gate, into the service,
 * staff and time steps — and stops at the confirm step. The moment #746 is
 * fixed, the last assertion here should become "expect(booking-success)".
 * That is the honest line, and it is written down so nobody has to guess where
 * it was drawn.
 */

const SLUG = "e2e-smoke-salon";

test.describe("@smoke — the flows that must never break", () => {
  test.beforeAll(async () => {
    await seedTestSalon({ slug: SLUG, name: "E2E Smoke Salon" });
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("home page responds 200", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
  });

  test("an active salon's booking page responds 200 and renders the salon", async ({
    page,
  }) => {
    const res = await page.goto(`/${SLUG}`);
    expect(res?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: /E2E Smoke Salon/i }),
    ).toBeVisible();
  });

  test("an unknown slug returns a real 404, not a 200 carrying a Not-found page", async ({
    page,
  }) => {
    // The status code is the assertion. Checking for the words "Not found" would
    // have passed happily throughout the soft-404 bug — the page always LOOKED
    // right; only the part crawlers read was wrong. See PR #743.
    const res = await page.goto("/definitely-not-a-salon-x7q2");
    expect(res?.status()).toBe(404);
  });

  test("the dashboard is gated when signed out", async ({ page }) => {
    await page.goto("/dashboard/some-salon");
    await expect(page).toHaveURL(/\/login/);
  });

  test("superadmin is gated when signed out", async ({ page }) => {
    await page.goto("/superadmin/salons");
    await expect(page).toHaveURL(/\/superadmin\/login/);
  });

  test("a salon slug that merely starts with 'dashboard' is NOT treated as the dashboard", async ({
    page,
  }) => {
    // pathname.startsWith("/dashboard") also matched /dashboard-abc, and a salon
    // that registered `dashboard-nails` had its public booking page 307'd to
    // /login — its own customers could not book, and nothing looked broken from
    // our side. See PR #744.
    const res = await page.goto("/dashboard-not-a-real-salon");
    expect(res?.status()).toBe(404); // reaches the salon resolver, which says no
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("the public booking flow reaches the service, staff and time steps", async ({
    page,
  }) => {
    // Through the phone-first gate and into the picker. Stops before submit —
    // see the note at the top of this file.
    await gotoBookingServiceStep(page, SLUG);

    await expect(
      page.locator('[data-testid="service-tile-select"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    // `any-staff-option`, taken from the specs that pass — not invented. A
    // guessed selector in a required gate is a red build for a reason that has
    // nothing to do with the product.
    await expect(
      page.locator('[data-testid="any-staff-option"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="any-staff-option"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    // Staff → DATE → time. The date step is not optional; my first draft jumped
    // straight to the slots and went red for a reason that had nothing to do
    // with the product. The order here is copied from the specs that pass, not
    // reasoned about.
    const day = page.locator('[data-testid="date-day"]:not([disabled])').first();
    await expect(day).toBeVisible({ timeout: 15_000 });
    await day.click();

    await expect(page.locator('[data-testid="time-slot"]').first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
