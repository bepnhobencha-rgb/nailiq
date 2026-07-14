import { test, expect } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

/**
 * An unknown salon slug must answer with a real HTTP 404, not a 200 carrying a
 * "Not found" page.
 *
 * This is not cosmetic. A soft 404 tells Google the page is live, so every
 * mistyped or dead salon URL gets indexed as thin content; it also poisons CDN
 * caches and hides real breakage from error monitoring, which reads 2xx as
 * healthy.
 *
 * The bug: notFound() was called from inside a <Suspense> boundary, so the 200
 * header had already been streamed by the time it threw. Next swapped in the
 * not-found UI and left the status alone.
 *
 * The status code is the entire point of these assertions. A test that checked
 * for the visible "Not found" text would have passed happily throughout the
 * bug — the page always LOOKED right; only the part crawlers read was wrong.
 */

const SLUG = "e2e-not-found-status";

test.describe("public booking — HTTP status", () => {
  test.beforeAll(async () => {
    await seedTestSalon({ slug: SLUG, name: "E2E Not Found Status" });
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("unknown slug returns a real 404", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-real-salon-x7q2");
    expect(response?.status()).toBe(404);
  });

  test("a reserved slug returns a real 404", async ({ page }) => {
    // `aggressive` is in RESERVED_BOOKING_SLUGS — it must never resolve as a
    // salon, and it too went out as 200 under the same Suspense bug.
    const response = await page.goto("/aggressive");
    expect(response?.status()).toBe(404);
  });

  test("an existing salon still returns 200", async ({ page }) => {
    // The guard rail: whatever we do to the 404 path must not break the salons
    // that pay for this.
    const response = await page.goto(`/${SLUG}`);
    expect(response?.status()).toBe(200);
  });
});
