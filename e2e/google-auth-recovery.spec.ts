import { expect, test } from "@playwright/test";

// Exercise the real browser SDK without reaching an Auth/Google provider.
// Fault injection only affects this page's PKCE hashing operation.
const copy = {
  en: { google: "Continue with Google", failed: "Google sign-in failed." },
  vi: { google: "Tiếp tục với Google", failed: "Đăng nhập Google thất bại." },
};

for (const language of ["en", "vi"] as const) {
  test(`${language}: in-app browser keeps Google disabled and email signup available`, async ({ page, context }) => {
    let authRequests = 0;
    await context.route("**/*", async route => {
      const request = route.request();
      if (new URL(request.url()).pathname.startsWith("/auth/v1/")) {
        authRequests++;
        return route.abort("blockedbyclient");
      }
      if (request.method() !== "GET" && request.method() !== "HEAD") {
        return route.fulfill({ status: 204, body: "" });
      }
      return route.continue();
    });
    await page.addInitScript(lang => {
      localStorage.setItem("nailiq-user-lang", lang);
      Object.defineProperty(navigator, "userAgent", {
        configurable: true, value: `${navigator.userAgent} [FBAN/Messenger]`,
      });
    }, language);
    await page.goto("/register");
    await expect(page.getByTestId("social-auth-controls")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByRole("button", { name: copy[language].google, exact: true })).toBeDisabled();
    await expect(page.getByRole("button", {
      name: language === "vi" ? "Mở trong trình duyệt" : "Open in browser", exact: true,
    })).toBeVisible();
    await page.locator('input[inputmode="email"]').fill("e2e-google-recovery@example.com");
    await page.locator('input[type="password"]').fill("LocalFixtureOnly123!");
    await expect(page.getByTestId("password-signup-submit")).toBeEnabled();
    expect(authRequests).toBe(0);
  });

  for (const path of ["/login", "/register"] as const) {
    test(`${language} ${path}: Google initialization failure preserves the draft and permits manual retry`, async ({ page, context }, info) => {
      const errors: string[] = [];
      const handoffs: URL[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(lang => localStorage.setItem("nailiq-user-lang", lang), language);
      await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/auth/v1/authorize") {
          handoffs.push(url);
          return route.fulfill({ status: 200, contentType: "text/html",
            body: '<main data-testid="oauth-handoff">Intercepted OAuth handoff</main>' });
        }
        // No browser writes or external provider requests leave the test.
        if (request.method() !== "GET" && request.method() !== "HEAD") {
          return route.fulfill({ status: 204, body: "" });
        }
        const appOrigin = new URL(String(info.project.use.baseURL)).origin;
        if (url.origin !== appOrigin) return route.abort("blockedbyclient");
        return route.continue();
      });
      await page.goto(path);
      const google = page.getByRole("button", { name: copy[language].google, exact: true });
      await expect(google).toBeEnabled();
      const email = page.locator('input[inputmode="email"]');
      const password = page.locator('input[type="password"]');
      await email.fill("e2e-google-recovery@example.com");
      await password.fill("LocalFixtureOnly123!");
      await page.evaluate(() => {
        const original = crypto.subtle.digest.bind(crypto.subtle);
        Object.defineProperty(crypto.subtle, "digest", {
          configurable: true,
          value: () => Promise.reject(new DOMException("QA PKCE hashing failure", "OperationError")),
        });
        Reflect.set(window, "restoreQaDigest", () => {
          Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: original });
        });
      });
      await google.click();
      await expect(page.locator('main [role="alert"]')).toHaveText(copy[language].failed);
      await expect(google).toBeEnabled();
      await expect(email).toHaveValue("e2e-google-recovery@example.com");
      await expect(password).toHaveValue("LocalFixtureOnly123!");
      expect(new URL(page.url()).pathname).toBe(path);
      expect(handoffs).toHaveLength(0);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: info.outputPath("google-recovery.png"), fullPage: true });

      await page.evaluate(() => Reflect.get(window, "restoreQaDigest")());
      await google.click();
      await expect(page.getByTestId("oauth-handoff")).toBeVisible();
      expect(handoffs).toHaveLength(1);
      const target = handoffs[0];
      expect(target.searchParams.get("provider")).toBe("google");
      expect(target.searchParams.get("code_challenge_method")).toBe("s256");
      expect(target.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(target.searchParams.get("redirect_to")).toMatch(/\/auth\/callback$/);
      expect(errors).toEqual([]);
    });
  }
}
