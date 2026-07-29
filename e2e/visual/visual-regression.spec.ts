/**
 * Visual regression baseline coverage.
 *
 * Captures full-page screenshots of the four highest-traffic surfaces at
 * desktop (1280×800) and mobile (390×844 — iPhone 14) widths. Baselines
 * live in `e2e/visual/__screenshots__/`; the CI workflow only refreshes
 * them when the merge commit message contains `[update-snapshots]`.
 *
 * Skipped when the service-role key is missing (no salon to seed against).
 */
import { test, expect, type Page } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "../helpers/db";

const VISUAL_SLUG = "e2e-visual-salon";
const DEMO_COOKIE = "nailiq-demo-slug";
const SALON_PHONE = "15558881212";
const VISUAL_DATE_YMD = "2026-07-22";
// 10:00 AM in the seeded salon's default America/Vancouver timezone.
// Keep browser-owned date/brief/Now-line rendering stable across CI runs.
const VISUAL_NOW_ISO = "2026-07-22T17:00:00.000Z";

const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "mobile", width: 390, height: 844 },
] as const;

const SCREENSHOT_OPTS = {
  fullPage: true,
  maxDiffPixelRatio: 0.02,
  // Animations are everywhere in this app (Framer Motion); disabling them
  // is the only way to get a stable pixel comparison.
  animations: "disabled" as const,
  caret: "hide" as const,
};

async function seedDemoCookie(page: Page, slug: string) {
  await page.context().addCookies([
    {
      name: DEMO_COOKIE,
      value: slug,
      url: page.url() && page.url() !== "about:blank"
        ? new URL(page.url()).origin
        : (process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"),
    },
  ]);
}

async function waitForVisualUi(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function waitForVisibleImages(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const visibleImages = Array.from(document.images).filter((image) => {
            const rect = image.getBoundingClientRect();
            const style = window.getComputedStyle(image);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < window.innerHeight &&
              rect.left < window.innerWidth
            );
          });

          return (
            visibleImages.length > 0 &&
            visibleImages.every(
              (image) => image.complete && image.naturalWidth > 0,
            )
          );
        }),
      {
        message: "visible booking imagery should finish loading",
        timeout: 15_000,
      },
    )
    .toBe(true);
}

test.describe("Visual regression", () => {
  test.skip(
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
    "Visual regression requires SUPABASE_SERVICE_ROLE_KEY to seed a test salon",
  );

  test.beforeAll(async () => {
    await seedTestSalon({
      phone: "15558881111",
      slug: VISUAL_SLUG,
      name: "E2E Visual Salon",
      salon_phone: SALON_PHONE,
    });
  });

  test.afterAll(async () => {
    await cleanupTestSalon(VISUAL_SLUG);
  });

  test.beforeEach(async ({ page }) => {
    // setFixedTime keeps timers and requestAnimationFrame running, unlike
    // pausing the clock, while making Date.now/new Date deterministic.
    await page.clock.setFixedTime(VISUAL_NOW_ISO);
  });

  for (const vp of VIEWPORTS) {
    test.describe(`@${vp.label} (${vp.width}x${vp.height})`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      test("public booking page", async ({ page }) => {
        await page.goto(`/${VISUAL_SLUG}`);
        // `networkidle` alone can resolve while the route's Suspense fallback is
        // still visible. #book exists only in the resolved booking body.
        await expect(page.locator("#book")).toBeVisible();
        await waitForVisualUi(page);
        // The desktop hero and ambient photos are lazy-loaded. `networkidle`
        // may fire before the browser schedules those requests, which otherwise
        // records empty photo frames as an accepted baseline.
        if (vp.label === "desktop") {
          await waitForVisibleImages(page);
        }
        await expect(page).toHaveScreenshot(
          `booking-${vp.label}.png`,
          SCREENSHOT_OPTS,
        );
      });

      test("register page", async ({ page }) => {
        await page.goto("/register");
        await waitForVisualUi(page);
        await expect(page).toHaveScreenshot(
          `register-${vp.label}.png`,
          SCREENSHOT_OPTS,
        );
      });

      test("receptionist center", async ({ page }) => {
        await page.goto("/");
        await seedDemoCookie(page, VISUAL_SLUG);
        await page.goto(
          `/dashboard/${VISUAL_SLUG}/center?date=${VISUAL_DATE_YMD}&e2eNow=${encodeURIComponent(VISUAL_NOW_ISO)}`,
        );
        await expect(page.getByTestId("receptionist-center-loaded")).toBeVisible();
        await expect(page.getByTestId("rc-hydrated")).toHaveCount(1);
        // Desktop renders StaffTimelineGrid; the mobile breakpoint swaps it
        // for VerticalDayView after hydration.
        await expect(
          page.locator(
            '[data-testid="staff-timeline-grid"], [data-testid="vertical-day-view"]',
          ),
        ).toBeVisible();
        await waitForVisualUi(page);
        await expect(page).toHaveScreenshot(
          `dashboard-center-${vp.label}.png`,
          SCREENSHOT_OPTS,
        );
      });

      test("setup wizard step 1", async ({ page }) => {
        await page.goto("/");
        await seedDemoCookie(page, VISUAL_SLUG);
        // /dashboard/[slug]/setup has no index — the first step is /setup/address.
        await page.goto(`/dashboard/${VISUAL_SLUG}/setup/address`);
        await waitForVisualUi(page);
        await expect(page).toHaveScreenshot(
          `dashboard-setup-${vp.label}.png`,
          SCREENSHOT_OPTS,
        );
      });
    });
  }
});
