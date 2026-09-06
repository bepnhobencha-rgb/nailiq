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
  getRegisteredSalonForUser,
  seedTestSalon,
  seedTestUser,
  setReactInputValue,
} from "./helpers/db";

/** Mirrors `normalizeRegisterPhone` — OTP rows use canonical digits (NANP gets leading 1). */
function normalizedDigits(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10 && /^[2-9]\d{9}$/.test(d)) return `1${d}`;
  return d;
}

test.describe("Registration flow", () => {
  test("New owner creates a salon, receives a no-card 14-day trial, and reaches Dashboard", async ({
    page,
  }) => {
    const { userId, email, password } = await seedTestUser();
    const uniqueSuffix = userId.slice(0, 8);
    const salonName = `E2E Registration ${uniqueSuffix}`;

    try {
      await page.goto("/register");
      await page.waitForLoadState("networkidle");

      // Fill the primary email/password form.
      const emailInput = page.locator('input[inputMode="email"]');
      await emailInput.fill(email);
      await page.locator('input[type="password"]').fill(password);

      // Click "Sign in" — signs in to existing account (created by seedTestUser).
      await page.getByTestId("password-signin-submit").click();

      // A confirmed account with no salon must enter the real setup wizard even
      // though DEMO_OTP=true is enabled for the rest of the E2E suite.
      await expect(page).toHaveURL(/\/register\/setup(?:\?|$)/, {
        timeout: 15_000,
      });

      const salonNameInput = page.locator("#register-setup-salon-name");
      await expect(salonNameInput).toBeEditable();
      await expect(page.getByTestId("registration-safe-start")).toContainText(
        /Private until you approve Go-Live|Giữ riêng tư đến khi Owner duyệt Go-Live/i,
      );
      const advancedSettings = page.locator("details").filter({
        hasText: /booking URL and time zone|link booking và múi giờ/i,
      });
      await advancedSettings.locator("summary").click();
      await expect(page.locator("#register-setup-slug")).toBeEditable();
      await expect(page.locator("#register-setup-timezone")).toHaveValue(
        "America/Vancouver",
      );
      const createButton = page.getByRole("button", {
        name: /create salon workspace|tạo không gian salon/i,
      });
      // The streamed input can be editable before React has attached its
      // controlled onChange handler. Retry the native InputEvent until the
      // product state enables submit; a one-shot fill can be overwritten by
      // hydration and leave a visibly empty field.
      await expect(async () => {
        await setReactInputValue(salonNameInput, salonName);
        await expect(salonNameInput).toHaveValue(salonName);
        await expect(createButton).toBeEnabled();
      }).toPass({ timeout: 15_000 });

      const submittedAfter = Date.now();
      await createButton.click();

      await expect(page).toHaveURL(/\/register\/success\?/, {
        timeout: 30_000,
      });
      await expect(page.getByTestId("registration-launch-status")).toContainText(
        /not live yet|chưa Live/i,
      );

      const registration = await getRegisteredSalonForUser(userId);
      const { salon } = registration;
      const trialStartedAt = Date.parse(salon.trial_started_at ?? "");
      const trialEndsAt = Date.parse(salon.trial_ends_at ?? "");

      expect(registration.memberRole).toBe("owner");
      expect(salon.name).toBe(salonName);
      expect(salon.timezone).toBe("America/Vancouver");
      expect(salon.profile_complete).toBe(false);
      expect(salon.setup_wizard_completed_at).toBeTruthy();
      expect(salon.subscription_plan).toBe("free");
      expect(salon.subscription_status).toBe("trialing");
      expect(trialStartedAt).toBeGreaterThanOrEqual(submittedAfter);
      expect(trialEndsAt - trialStartedAt).toBe(14 * 24 * 60 * 60 * 1_000);
      expect(salon.stripe_customer_id).toBeNull();
      expect(salon.stripe_subscription_id).toBeNull();
      expect(salon.payment_provider).toBeNull();
      expect(salon.sms_outbound_enabled).toBe(false);
      expect(salon.email_outbound_enabled).toBe(false);
      expect(salon.email_links_enabled).toBe(false);
      expect(salon.reminders_enabled).toBe(false);
      expect(salon.reminder_24h_enabled).toBe(false);
      expect(salon.reminder_3h_enabled).toBe(false);
      expect(salon.sms_reminders_enabled).toBe(false);
      expect(salon.voice_ai_enabled).toBe(false);
      expect(salon.noshow_protection_enabled).toBe(false);
      expect(salon.winback_enabled).toBe(false);
      expect(registration.serviceCount).toBeGreaterThan(0);
      expect(registration.staffCount).toBe(1);

      await page
        .getByRole("button", {
          name: /start coco setup|bắt đầu coco setup|go to dashboard|vào bảng điều khiển/i,
        })
        .click();

      await expect(page).toHaveURL(
        new RegExp(`/dashboard/${salon.slug}(?:[/?#]|$)`),
        { timeout: 30_000 },
      );
      await expect(page.locator("main")).toBeVisible();
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
