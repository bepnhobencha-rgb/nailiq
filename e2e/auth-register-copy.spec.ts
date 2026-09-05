import { expect, test } from "@playwright/test";

test.describe("Registration action hierarchy", () => {
  for (const project of [
    {
      language: "vi",
      section: "Tạo tài khoản bằng email",
      signUp: "Đăng ký",
      signIn: "Đã có tài khoản? Đăng nhập",
    },
    {
      language: "en",
      section: "Create an account with email",
      signUp: "Sign up",
      signIn: "Already have an account? Sign in",
    },
  ] as const) {
    test(`${project.language} prioritizes account creation`, async ({ page }) => {
      await page.addInitScript((language) => {
        window.localStorage.setItem("nailiq-user-lang", language);
      }, project.language);
      await page.goto("/register");
      await page.waitForLoadState("networkidle");

      await expect(
        page.getByText(project.section, { exact: true }),
      ).toBeVisible();

      const signUp = page.getByRole("button", {
        name: project.signUp,
        exact: true,
      });
      const existingAccountSignIn = page.getByRole("button", {
        name: project.signIn,
        exact: true,
      });

      await expect(signUp).toBeVisible();
      await expect(existingAccountSignIn).toBeVisible();
      await expect(page.getByTestId("password-signup-submit")).toBeVisible();
      await expect(page.getByTestId("password-signin-submit")).toBeVisible();
      await expect(page.locator('input[type="password"]')).toHaveAttribute(
        "autocomplete",
        "new-password",
      );

      const passwordActions = await signUp
        .locator("..")
        .getByRole("button")
        .allTextContents();
      expect(passwordActions.map((label) => label.trim())).toEqual([
        project.signUp,
        project.signIn,
      ]);
    });
  }
});
