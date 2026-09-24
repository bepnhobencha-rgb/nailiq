import { expect, type Page } from "@playwright/test";

/** Sign in through the public form; never manufacture an owner demo session. */
export async function loginReceptionist(page: Page, user: { email: string; password: string }) {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute("data-hydrated", "true");
  await page.locator('input[inputmode="email"]').fill(user.email);
  await page.locator('input[type="password"]').fill(user.password);
  await page.getByTestId("password-signin-submit").click();
  await page.waitForURL(/\/dashboard\//);
  await page.waitForLoadState("load", { timeout: 30_000 });
  expect((await page.context().cookies()).some(cookie => cookie.name === "nailiq-demo-slug")).toBe(false);
}
