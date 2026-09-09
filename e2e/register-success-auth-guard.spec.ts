import { expect, test } from "@playwright/test";

test.describe("Registration success authentication", () => {
  for (const route of [
    "/register/success",
    "/register/success?slug=e2e-uncreated-workspace&adjusted=1",
  ]) {
    test(`signed-out request cannot render success: ${route}`, async ({ page, request }) => {
      const response = await request.get(route, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(response.headers().location).toBe("/register");
      expect(await response.text()).not.toContain('data-testid="registration-launch-status"');

      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        const detectSuccess = () => {
          if (document.querySelector('[data-testid="registration-launch-status"]')) {
            sessionStorage.setItem("e2e-success-flash", "seen");
          }
        };
        new MutationObserver(detectSuccess).observe(document, { childList: true, subtree: true });
      });
      await page.goto(route);
      await expect(page).toHaveURL(/\/register$/);
      await expect(page.getByTestId("password-signin-submit")).toBeVisible();
      await expect(page.getByTestId("registration-launch-status")).toHaveCount(0);
      expect(await page.evaluate(() => sessionStorage.getItem("e2e-success-flash"))).toBeNull();
      expect(errors).toEqual([]);
      await test.info().attach("signed-out-register", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });
  }
});
