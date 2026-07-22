/**
 * Landing page → self-service trial / demo funnel tests.
 *
 * Covers every CTA entry point a prospective owner can use to begin a
 * self-service trial, request a demo, or sign in as a
 * returning owner. Tests are scoped to navigation intent: each CTA
 * click must land on the correct destination and that page must be
 * functional (not a 404 or redirect loop).
 *
 * Self-service destinations (2026-07):
 *   Try-Free/Hero primary/Final primary → /register?intent=trial
 *   Hero secondary / final CTA secondary → /contact?intent=demo
 *   Pricing Core CTA → /register?intent=trial
 *   Pricing setup CTA → /contact?intent=setup
 *   Sign In → /login (unchanged)
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

test.describe("Landing page → self-service trial funnel", () => {
  test.describe("Navbar CTAs", () => {
    async function openMobileMenuIfNeeded(page: Page) {
      const hamburger = page.getByRole("button", { name: /open menu/i });
      if (await hamburger.isVisible()) {
        await hamburger.click();
        await page.waitForTimeout(200);
      }
    }

    test("Sign In link navigates to /login", async ({ page }) => {
      await gotoLanding(page);
      await openMobileMenuIfNeeded(page);

      const desktopLink = page.getByTestId("nav-sign-in");
      const mobileLink = page.getByTestId("nav-mobile-sign-in");
      const link = (await desktopLink.isVisible()) ? desktopLink : mobileLink;
      await link.click();

      await expect(page).toHaveURL(/\/login/);
      await expect(page).not.toHaveURL(/error/);
    });

    test("Try-free CTA (nav-try-free) navigates to the self-service trial", async ({
      page,
    }) => {
      await gotoLanding(page);
      await openMobileMenuIfNeeded(page);

      const desktopBtn = page.getByTestId("nav-try-free");
      const mobileBtn = page.getByTestId("nav-mobile-try-free");
      const btn = (await desktopBtn.isVisible()) ? desktopBtn : mobileBtn;
      await btn.click();

      await expect(page).toHaveURL(/\/register\?intent=trial/);
      await expect(
        page.getByRole("heading", { name: /get started with nailiq/i }),
      ).toBeVisible();
    });
  });

  test.describe("Hero CTAs", () => {
    test("primary CTA navigates to the self-service trial", async ({
      page,
    }) => {
      await gotoLanding(page);
      await page.getByTestId("hero-cta-primary").click();
      await expect(page).toHaveURL(/\/register\?intent=trial/);
      await expect(
        page.getByRole("heading", { name: /get started with nailiq/i }),
      ).toBeVisible();
    });

    test("secondary CTA navigates to /contact with demo intent", async ({
      page,
    }) => {
      await gotoLanding(page);
      await page.getByTestId("hero-cta-secondary").click();
      await expect(page).toHaveURL(/\/contact\?intent=demo/);
      await expect(page.getByTestId("contact-form")).toBeVisible();
      await expect(page.getByTestId("contact-intent-demo")).toBeVisible();
    });
  });

  test.describe("Pricing CTAs", () => {
    test("Core plan CTA navigates to the self-service trial", async ({
      page,
    }) => {
      await gotoLanding(page);
      await scrollToBottom(page);

      const cta = page.getByTestId("pricing-cta-trial");
      await expect(cta).toBeVisible({ timeout: 10_000 });
      await cta.click();

      await expect(page).toHaveURL(/\/register\?intent=trial/);
    });

    test("Setup help CTA opens the setup request", async ({
      page,
    }) => {
      await gotoLanding(page);
      await scrollToBottom(page);

      const cta = page.getByTestId("pricing-cta-setup");
      await expect(cta).toBeVisible({ timeout: 10_000 });
      await cta.click();

      await expect(page).toHaveURL(/\/contact\?intent=setup/);
      await expect(page.getByTestId("contact-form")).toBeVisible();
    });
  });

  test.describe("Final CTA section", () => {
    test("primary bottom CTA navigates to the self-service trial", async ({
      page,
    }) => {
      await gotoLanding(page);
      await scrollToBottom(page);

      const cta = page.getByTestId("final-cta-primary");
      await expect(cta).toBeVisible({ timeout: 10_000 });
      await cta.click();

      await expect(page).toHaveURL(/\/register\?intent=trial/);
    });

    test("secondary bottom CTA navigates to /contact with demo intent", async ({
      page,
    }) => {
      await gotoLanding(page);
      await scrollToBottom(page);

      const cta = page.getByTestId("final-cta-secondary");
      await expect(cta).toBeVisible({ timeout: 10_000 });
      await cta.click();

      await expect(page).toHaveURL(/\/contact\?intent=demo/);
      await expect(page.getByTestId("contact-form")).toBeVisible();
    });
  });

  test.describe("Mobile navbar CTAs", () => {
    test("mobile menu try-free CTA navigates to the self-service trial", async ({
      page,
    }) => {
      await gotoLanding(page);

      const hamburger = page.getByRole("button", { name: /open menu/i });
      if (await hamburger.isVisible()) {
        await hamburger.click();
        await page.getByTestId("nav-mobile-try-free").click();
        await expect(page).toHaveURL(/\/register\?intent=trial/);
      } else {
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
  // Smoke-tests the destination page itself. The landing marketing funnel
  // intentionally points here so owners can start the no-card trial directly.
  test("renders auth form (Google + email)", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("nailiq-user-lang", "en");
    });
    await page.goto("/register");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { name: /get started with nailiq/i }),
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
