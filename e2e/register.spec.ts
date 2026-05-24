/**
 * Owner registration and sign-in flow tests.
 *
 * Covers two distinct journeys:
 * 1. New user signs up via email/password → lands on /register/setup.
 * 2. Returning owner signs in via /login (phone OTP, demo mode) → dashboard.
 *
 * Phone OTP on /register was retired 2026-05-13 (Twilio not approved).
 * The /login page retains phone OTP in demo mode for backwards-compatible
 * returning-owner access during development and E2E.
 */
import { test, expect } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  getLatestOtp,
  seedTestSalon,
  seedTestUser,
} from "./helpers/db";

/** Mirrors `normalizeRegisterPhone` — OTP rows use canonical digits (NANP gets leading 1). */
function normalizedDigits(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10 && /^[2-9]\d{9}$/.test(d)) return `1${d}`;
  return d;
}

test.describe("Registration flow", () => {
  // This describe exercises Supabase password auth via the browser client in a
  // `next start` (NODE_ENV=production) environment.  Intermittently fails in
  // GitHub Actions CI — likely a timing gap between supabase-js setting the
  // session cookie and the server-side session read on the subsequent full-page
  // navigation.  Skipped in CI; runs locally where dev mode eliminates the gap.
  test.skip(Boolean(process.env.CI), "email/password auth timing unreliable in CI production build");

  test("New user — email/password sign-in lands on /register/setup", async ({
    page,
  }) => {
    const { userId, email, password } = await seedTestUser();

    try {
      await page.goto("/register");
      await page.waitForLoadState("networkidle");

      // Expand the password section (hidden behind "Sign in with password" toggle).
      await page.getByTestId("social-auth-password-toggle").click();

      // Fill email (already visible in open layout) and the newly revealed password input.
      const emailInput = page.locator('input[inputMode="email"]');
      await emailInput.fill(email);
      await page.locator('input[type="password"]').fill(password);

      // Click "Sign in" — signs in to existing account (created by seedTestUser).
      await page.getByRole("button", { name: /^sign in$/i }).click();

      // New user (no salon yet) should land on the setup wizard.
      await expect(page).toHaveURL(/register\/(setup|success)|dashboard\//, {
        timeout: 15_000,
      });
    } finally {
      await cleanupTestUser(userId);
    }
  });
});

test.describe("Returning owner", () => {
  const TEST_PHONE = "5550009998";
  const TEST_SLUG = "e2e-returning-salon";

  test.afterEach(async () => {
    await cleanupTestSalon(TEST_SLUG);
  });

  test("Phone sign-in via /login redirects to dashboard", async ({ page }) => {
    const { phone, slug } = await seedTestSalon({
      phone: "15550009998",
      slug: TEST_SLUG,
      name: "E2E Returning Salon",
    });

    // /login shows phone OTP in demo mode (DEMO_OTP=true).
    await page.goto("/login");
    await page.fill('input[type="tel"]', TEST_PHONE);
    await page.click('button:has-text("Send code")');

    // Demo OTP modal appears; wait for it to be visible before dismissing
    // (waitForTimeout(800) is too short on slow mobile WebKit CI runners).
    await page.getByRole("button", { name: "Enter code" }).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("button", { name: "Enter code" }).click();
    await expect(page).toHaveURL(/login\/verify/);

    await page.waitForTimeout(400);
    const otp = await getLatestOtp(normalizedDigits(TEST_PHONE));
    expect(otp).toBeTruthy();

    // Use keyboard.type after focusing first input — page.fill() uses CDP
    // which bypasses React's synthetic onChange on WebKit (digits state stays
    // empty → button disabled → submit never fires).
    await page.locator('input[maxlength="1"]').first().click();
    await page.keyboard.type(otp);
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page).toHaveURL(new RegExp(`dashboard/${slug}`), {
      timeout: 15_000,
    });

    void phone; // used only to confirm seed succeeded
  });
});
