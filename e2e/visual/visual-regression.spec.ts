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

  for (const vp of VIEWPORTS) {
    test.describe(`@${vp.label} (${vp.width}x${vp.height})`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      test("public booking page", async ({ page }) => {
        await page.goto(`/${VISUAL_SLUG}`);
        await page.waitForLoadState("networkidle");
        await expect(page).toHaveScreenshot(
          `booking-${vp.label}.png`,
          SCREENSHOT_OPTS,
        );
      });

      test("register page", async ({ page }) => {
        await page.goto("/register");
        await page.waitForLoadState("networkidle");
        await expect(page).toHaveScreenshot(
          `register-${vp.label}.png`,
          SCREENSHOT_OPTS,
        );
      });

      test("receptionist center", async ({ page }) => {
        await page.goto("/");
        await seedDemoCookie(page, VISUAL_SLUG);
        await page.goto(`/dashboard/${VISUAL_SLUG}/center`);
        await page.waitForLoadState("networkidle");
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
        await page.waitForLoadState("networkidle");
        await expect(page).toHaveScreenshot(
          `dashboard-setup-${vp.label}.png`,
          SCREENSHOT_OPTS,
        );
      });
    });
  }
});
