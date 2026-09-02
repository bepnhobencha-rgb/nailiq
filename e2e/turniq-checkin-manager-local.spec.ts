import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PATH = "/e2e-local/turniq-checkin-manager";

test.describe("TurnIQ M4O check-in QR lifecycle local story", () => {
  test("active QR is printable, cannot be silently replaced, and can be revoked", async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => document.documentElement.setAttribute("data-print-requested", "true");
    });
    await page.goto(PATH);
    await page.getByRole("button", { name: "Create secure QR" }).click();

    await expect(page.getByTestId("turniq-active-qr")).toBeVisible();
    await expect(page.getByRole("img", { name: "Active customer check-in QR" })).toBeVisible();
    await expect(page.getByRole("timer")).toContainText(/remaining/);
    await expect(page.getByRole("button", { name: "One appointment QR" })).toBeDisabled();

    await page.getByRole("button", { name: "Print customer check-in QR" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-print-requested", "true");

    await page.getByRole("button", { name: "Revoke customer check-in QR" }).click();
    await expect(page.getByTestId("turniq-active-qr")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("QR đã thu hồi");
    await expect(page.getByRole("button", { name: "One appointment QR" })).toBeEnabled();
  });

  test("expired QR is visibly blocked and can be replaced", async ({ page }) => {
    await page.goto(`${PATH}?expiry=short`);
    await page.getByRole("button", { name: "Create secure QR" }).click();
    await expect(page.getByText("Do not use this QR / Không dùng QR này", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("img", { name: "Expired customer check-in QR" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy secure check-in link" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Print customer check-in QR" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Create replacement QR" })).toBeEnabled();
  });

  test("manager controls have no automatic accessibility violations", async ({ page }) => {
    await page.goto(PATH);
    await page.getByRole("button", { name: "Create secure QR" }).click();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
