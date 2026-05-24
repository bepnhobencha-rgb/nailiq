/**
 * Landing page → registration funnel tests.
 *
 * Covers every CTA entry point a prospective owner can use to begin
 * registration or contact sales. Tests are scoped to navigation intent:
 * each CTA click must land on the correct destination and that page must
 * be functional (not a 404 or redirect loop).
 *
 * Pricing plan IDs (as of 2026-05):
 *   free ($0) · pro ($39) · studio ($89) · enterprise ($199 → /contact)
 *
 * No DB seeding required — all assertions are against public pages.
 */
import { test, expect, type Page } from "@playwright/test";

async function gotoLanding(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
}

async function scrollToBottom(page: Page) {
  await page.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
  );
  // Allow whileInView animations to start (framer-motion fires on next frame).
  await page.waitForTimeout(150);
}

test.describe("Landing page → register funnel", () => {
  test.describe("Navbar CTAs", () => {
    /**
     * Opens the mobile hamburger menu when the desktop nav links are hidden
     * (narrow viewport). On desktop viewports, does nothing.
     */
    async function openMobileMenuIfNeeded(page: Page) {
      const hamburger = page.getByRole("button", { name: /open menu/i });
      if (await hamburger.isVisible()) {
        await hamburger.click();
        // Brief settle so the slide-down animation completes before clicking a link.
        await page.waitForTimeout(200);
      }
    }

    test("Sign In link navigates to /login", async ({ page }) => {
      await gotoLanding(page);
      await openMobileMenuIfNeeded(page);

      // Desktop: nav-sign-in; mobile: nav-mobile-sign-in (revealed after hamburger).
      const desktopLink = page.getByTestId("nav-sign-in");
      const mobileLink  = page.getByTestId("nav-mobile-sign-in");
      const link = await desktopLink.isVisible() ? desktopLink : mobileLink;
      await link.click();

      await expect(page).toHaveURL(/\/login/);
      await expect(page).not.toHaveURL(/error/);
    });

    test("Try Free button navigates to /register", async ({ page }) => {
      await gotoLanding(page);
      await openMobileMenuIfNeeded(page);

      // Desktop: nav-try-free; mobile: nav-mobile-try-free.
      const desktopBtn = page.getByTestId("nav-try-free");
      const mobileBtn  = page.getByTestId("nav-mobile-try-free");
      const btn = await desktopBtn.isVisible() ? desktopBtn : mobileBtn;
      await btn.click();

      await expect(page).toHaveURL(/\/register/);
      await expect(
        page.getByRole("heading", { name: /sign in or sign up/i }),
      ).toBeVisible();
    });
  });

  test.describe("Hero CTA", () => {
    test("primary CTA navigates to /register and shows auth form", async ({
      page,
    }) => {
      await gotoLanding(page);
      await page.getByTestId("hero-cta-primary").click();
      await expect(page).toHaveURL(/\/register/);
      await expect(
        page.getByRole("heading", { name: /sign in or sign up/i }),
      ).toBeVisible();
    });
  });

  test.describe("Pricing plan CTAs", () => {
    // Free, Pro, Studio all go to /register; Enterprise goes to /contact.
    const REGISTER_PLANS = ["free", "pro", "studio"] as const;

    for (const planId of REGISTER_PLANS) {
      test(`"${planId}" plan CTA navigates to /register`, async ({ page }) => {
        await gotoLanding(page);
        await scrollToBottom(page);

        const cta = page.getByTestId(`pricing-cta-${planId}`);
        await expect(cta).toBeVisible({ timeout: 10_000 });
        await cta.click();

        await expect(page).toHaveURL(/\/register/);
        await expect(
          page.getByRole("heading", { name: /sign in or sign up/i }),
        ).toBeVisible();
      });
    }

    test("enterprise plan CTA navigates to /contact", async ({ page }) => {
      await gotoLanding(page);
      await scrollToBottom(page);

      const cta = page.getByTestId("pricing-cta-enterprise");
      await expect(cta).toBeVisible({ timeout: 10_000 });
      await cta.click();

      await expect(page).toHaveURL(/\/contact/);
      await expect(page).not.toHaveURL(/error/);
    });
  });

  test.describe("Final CTA section", () => {
    test("bottom CTA navigates to /register", async ({ page }) => {
      await gotoLanding(page);
      await scrollToBottom(page);

      const cta = page.getByTestId("final-cta-primary");
      await expect(cta).toBeVisible({ timeout: 10_000 });
      await cta.click();

      await expect(page).toHaveURL(/\/register/);
      await expect(
        page.getByRole("heading", { name: /sign in or sign up/i }),
      ).toBeVisible();
    });
  });

  test.describe("Mobile navbar CTAs", () => {
    // Uses the `mobile` project defined in playwright.config.ts.
    // These tests run on the `mobile` browser project automatically;
    // adding them here ensures the mobile menu is also exercised.
    test("mobile menu Try Free navigates to /register", async ({ page }) => {
      await gotoLanding(page);

      // Open mobile hamburger (visible only when viewport is narrow).
      const hamburger = page.getByRole("button", { name: /open menu/i });
      if (await hamburger.isVisible()) {
        await hamburger.click();
        await page.getByTestId("nav-mobile-try-free").click();
        await expect(page).toHaveURL(/\/register/);
        await expect(
          page.getByRole("heading", { name: /sign in or sign up/i }),
        ).toBeVisible();
      } else {
        // Desktop viewport: mobile nav not rendered — test is a no-op.
        test.skip();
      }
    });

    test("mobile menu Sign In navigates to /login", async ({ page }) => {
      await gotoLanding(page);

      const hamburger = page.getByRole("button", { name: /open menu/i });
      if (await hamburger.isVisible()) {
        await hamburger.click();
        await page.getByTestId("nav-mobile-sign-in").click();
        await expect(page).toHaveURL(/\/login/);
      } else {
        test.skip();
      }
    });
  });
});

test.describe("/register page integrity", () => {
  // Smoke-tests the destination page itself — not just the URL — so a
  // broken register page does not silently pass the funnel tests above.
  test("renders auth form (Google + email)", async ({ page }) => {
    await page.goto("/register");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { name: /sign in or sign up/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /continue with google/i }),
    ).toBeVisible();
    await expect(page.locator('input[inputMode="email"]')).toBeVisible();
  });

  test("page title is set (not empty / undefined)", async ({ page }) => {
    await page.goto("/register");
    const title = await page.title();
    expect(title).not.toBe("");
    expect(title).not.toContain("undefined");
  });
});
