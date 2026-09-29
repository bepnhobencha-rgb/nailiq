import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e-local/card-retry-email");
  await expect(page.getByRole("heading", { name: "QA synthetic — no network sending" })).toBeVisible();
});

test("English success uses email_only once and never claims inbox delivery", async ({ page }) => {
  const button = page.getByRole("button", { name: "Email save-card link only" });
  await button.click();

  await expect(page.getByRole("status").filter({ hasText: "Mock calls:" })).toHaveText("Mock calls: email_only");
  await expect(page.getByText("Email accepted for sending. No SMS sent; inbox delivery is not confirmed.")).toBeVisible();
  await expect(button).toBeDisabled();
});

test("English failure stays retryable and does not fall back to SMS", async ({ page }) => {
  await page.getByRole("button", { name: "Mode: success" }).click();
  const button = page.getByRole("button", { name: "Email save-card link only" });
  await button.click();

  await expect(page.getByRole("status").filter({ hasText: "Mock calls:" })).toHaveText("Mock calls: email_only");
  await expect(page.getByText("Email sending was not confirmed. Check the email address and delivery status before retrying. No SMS sent.")).toBeVisible();
  await expect(button).toBeEnabled();
});

test("Vietnamese keyboard submit reports email-only truth", async ({ page }) => {
  await page.getByRole("button", { name: "English / Tiếng Việt" }).click();
  const button = page.getByRole("button", { name: "Chỉ gửi link lưu thẻ qua email" });
  await button.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status").filter({ hasText: "Mock calls:" })).toHaveText("Mock calls: email_only");
  await expect(page.getByText("Email đã được tiếp nhận để gửi. Không gửi SMS; chưa xác nhận đã vào hộp thư.")).toBeVisible();
  await expect(button).toBeDisabled();
});

test("double tap cannot dispatch twice while pending", async ({ page }) => {
  const button = page.getByRole("button", { name: "Email save-card link only" });
  await button.dblclick();

  await expect(page.getByRole("status").filter({ hasText: "Mock calls:" })).toHaveText("Mock calls: email_only");
  await expect(button).toBeDisabled();
});
