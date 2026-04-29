import { test, expect } from "@playwright/test";

import { cleanupTestSalon, getLatestOtp, seedTestSalon } from "./helpers/db";

const TEST_PHONE = "5550009999";
const TEST_SLUG = "e2e-new-salon";

/** Mirrors `normalizeRegisterPhone` — OTP rows use canonical digits (NANP gets leading 1). */
function normalizedDigits(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10 && /^[2-9]\d{9}$/.test(d)) return `1${d}`;
  return d;
}

test.afterEach(async () => {
  await cleanupTestSalon(TEST_SLUG);
});

test("Register new salon — full flow", async ({ page }) => {
  await page.goto("/register");

  await page.fill('input[type="tel"]', TEST_PHONE);
  await page.click('button:has-text("Send code")');

  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Enter code" }).click();
  await expect(page).toHaveURL(/register\/verify/);

  await page.waitForTimeout(400);
  const otp = await getLatestOtp(normalizedDigits(TEST_PHONE));
  expect(otp).toBeTruthy();

  const otpInputs = page.locator('input[maxlength="1"]');
  for (let i = 0; i < 6; i++) {
    await otpInputs.nth(i).fill(otp[i]!);
  }

  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/register\/setup/);
  await page.fill('input[name="salonName"]', "E2E New Salon");
  await page.click('button:has-text("Create")');

  await expect(page).toHaveURL(/register\/success/);
  await expect(page.getByText(/live/i).first()).toBeVisible();
});

test("Returning owner — redirect to dashboard", async ({ page }) => {
  const { phone, slug } = await seedTestSalon({
    phone: "15551112222",
    slug: "e2e-returning-salon",
    name: "E2E Returning Salon",
  });

  const phoneInput = phone.replace(/^1/, "");

  await page.goto("/register");
  await page.fill('input[type="tel"]', phoneInput);
  await page.click('button:has-text("Send code")');

  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Enter code" }).click();
  await expect(page).toHaveURL(/register\/verify/);

  await page.waitForTimeout(400);
  const otp = await getLatestOtp(phone);
  expect(otp).toBeTruthy();

  const otpInputs = page.locator('input[maxlength="1"]');
  for (let i = 0; i < 6; i++) {
    await otpInputs.nth(i).fill(otp[i]!);
  }

  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(new RegExp(`dashboard/${slug}`), {
    timeout: 15_000,
  });
  await expect(page.getByText(/demo mode/i).first()).toBeVisible();

  await cleanupTestSalon(slug);
});
