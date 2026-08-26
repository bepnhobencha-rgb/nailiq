import { createHash } from "node:crypto";

import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { navigateToConfirmStep } from "../helpers/bookingFlow";
import {
  cleanupTestSalon,
  gotoBookingServiceStep,
  seedTestSalon,
} from "../helpers/db";

/**
 * A service-role client, so the booking test can read the row back out of
 * Postgres instead of trusting the screen. guardProduction has already run in
 * globalSetup — this cannot be pointed at production.
 */
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** Unique per run, so the DB lookup can name exactly the row this test made. */
const GUEST_NAME = `Smoke Guest ${process.env.GITHUB_RUN_ID ?? "local"}`;

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
  test.beforeEach(async ({ page }, testInfo) => {
    // Local/CI browser projects otherwise share one loopback source IP. A full
    // E2E run can legitimately consume the durable booking-page bucket before
    // smoke reaches its submit test, turning the page into a 429 mid-flow.
    // Keep the production limiter intact and give each disposable test its own
    // documentation-only address instead.
    const material = `${testInfo.project.name}:${testInfo.titlePath.join(":")}`;
    const digest = createHash("sha256").update(material).digest("hex");
    await page.setExtraHTTPHeaders({
      "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
    });
  });

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

  test("a guest can actually BOOK — verified in the database, not on the screen", async ({
    page,
  }) => {
    /**
     * The one that matters, and the one easiest to fake.
     *
     * A booking smoke that asserts "the success screen appeared" is worthless: a
     * screen is a screen. This one refuses to believe the UI. It watches the
     * network for a booking request that 4xx/5xx'd, refuses the presence of the
     * failure alert, and then goes and READS THE ROW out of Postgres — right
     * salon, right service, right staff, right guest, right time. If no row
     * exists, no amount of green pixels will save it.
     *
     * Nothing is mocked here. SMS and email are switched off at the process level
     * (DISABLE_OUTBOUND_SMS, empty provider keys) because a test must never text a
     * stranger — but the booking itself goes all the way through the real server
     * action and the real create_public_booking RPC into the real local database.
     * Mocking the RPC would turn this test into a mirror.
     */
    const failedBookingCalls: string[] = [];
    page.on("response", (res) => {
      const u = res.url();
      const isBooking =
        u.includes("/rest/v1/rpc/create_public_booking") ||
        u.includes("/api/booking");
      if (isBooking && res.status() >= 400) {
        failedBookingCalls.push(`${res.status()} ${u}`);
      }
    });

    await navigateToConfirmStep(page, SLUG, { name: GUEST_NAME });

    await page.getByTestId("sms-consent").check();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    // Race the two possible outcomes rather than asserting the absence of the
    // error first.
    //
    // My first cut checked `expect(errorAlert).toHaveCount(0)` immediately after
    // the click — which passes trivially, because the server has not answered
    // yet. It is the shape of assertion that looks rigorous and proves nothing,
    // and it nearly led me to the wrong conclusion about WHY booking fails.
    //
    // Waiting for "success OR failure" is honest: whichever the product actually
    // does, we see it, and if it is the failure we say so in the error message
    // instead of reporting a bare "booking-success not found" 20 seconds later.
    const success = page.getByTestId("booking-success");
    const failure = page.getByText(/Could not complete booking/i);

    await expect(success.or(failure).first()).toBeVisible({ timeout: 20_000 });

    await expect(
      failure,
      "the product REFUSED the booking — it showed 'Could not complete booking'",
    ).toHaveCount(0);
    await expect(success).toBeVisible();

    expect(failedBookingCalls, "a booking request returned 4xx/5xx").toEqual([]);

    // ── The assertion the screen cannot fake ──────────────────────────────────
    const { data: salon } = await db
      .from("salons")
      .select("id")
      .eq("slug", SLUG)
      .single();
    expect(salon?.id, "the smoke salon should exist").toBeTruthy();

    const { data: bookings, error } = await db
      .from("bookings")
      .select("id, salon_id, service_id, staff_id, client_name, start_time_utc, status")
      .eq("salon_id", salon!.id)
      .eq("client_name", GUEST_NAME);

    expect(error, "reading bookings back").toBeNull();
    expect(
      bookings?.length,
      "exactly one booking row should exist for this guest — the UI said it booked",
    ).toBe(1);

    const booking = bookings![0];
    expect(booking.id, "booking_id").toBeTruthy();
    expect(booking.service_id, "booking must carry the chosen service").toBeTruthy();
    expect(booking.staff_id, "booking must carry the chosen staff").toBeTruthy();
    expect(booking.start_time_utc, "booking must carry a start time").toBeTruthy();
    expect(
      new Date(booking.start_time_utc as string).getTime(),
      "the booking must be in the future",
    ).toBeGreaterThan(Date.now());
    expect(["pending", "confirmed"]).toContain(booking.status);

    // Cleanup: this exact row. cleanupTestSalon in afterAll removes the salon and
    // cascades anyway, but a test that creates a row should be able to name it.
    const { error: delErr } = await db
      .from("bookings")
      .delete()
      .eq("id", booking.id);
    expect(delErr, "cleaning up the booking this test created").toBeNull();
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
