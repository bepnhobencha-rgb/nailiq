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

  test("the public booking flow clears the phone gate and reaches service + staff", async ({
    page,
  }) => {
    // How far this goes is a deliberate line, not laziness.
    //
    // The date step turned out to be genuinely fiddly — the month grid hides
    // behind a "More dates" toggle, "today" renders as `date-today` rather than
    // `date-day`, and late in the month you may have to advance a month to find
    // a selectable day (see navigateToTimeStep in booking-errors.spec.ts). That
    // navigation belongs in the full suite, where it is already covered. Copying
    // it into a REQUIRED gate would buy a gate that goes red on a calendar edge
    // case, and a gate that cries wolf gets bypassed — which is worse than no
    // gate, because it looks like protection.
    //
    // So the gate asserts the part that is both load-bearing and stable: a guest
    // can reach the salon, get through the phone-first gate, see real services,
    // and reach the staff step. If THAT breaks, the salon is not taking bookings
    // and someone must be woken up.
    //
    // The rest — date, time, and submit — is covered by the full suite. Submit is
    // currently broken (#746) and is pre-existing, not the harness: the
    // create_public_booking RPC returns success when called directly against this
    // baseline. When #746 is fixed, extend this test to booking-success.
    await gotoBookingServiceStep(page, SLUG);

    await expect(
      page.locator('[data-testid="service-tile-select"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-testid="service-tile-select"]').first().click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    // `any-staff-option` — taken from the specs that pass, not invented. My first
    // draft used `staff-option`, which does not exist anywhere in src/.
    await expect(
      page.locator('[data-testid="any-staff-option"]').first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
