import { expect, test, type Page } from "@playwright/test";

// Browser-boundary regression: every POST is intercepted before it can reach
// Auth, a provider or the database. A rejected transport response keeps the
// form visible so each submitted action and the retained draft can be checked.
const email = "e2e-auth-keyboard@example.com";
const password = "LocalFixtureOnly123!";
const copy = {
  en: {
    failed: "We could not confirm whether your request completed. Wait a few minutes, then try again.",
    magic: "Forgot password? Send a login link",
    emailRequired: "Enter your email above first.",
    emailInvalid: "Enter a valid email address.",
    passwordRequired: "Enter your password.",
  },
  vi: {
    failed: "Chưa thể xác nhận yêu cầu đã hoàn tất. Hãy đợi vài phút rồi thử lại.",
    magic: "Quên mật khẩu? Gửi link đăng nhập vào email",
    emailRequired: "Vui lòng nhập email phía trên trước.",
    emailInvalid: "Email không hợp lệ.",
    passwordRequired: "Vui lòng nhập mật khẩu.",
  },
} as const;
type Language = keyof typeof copy;
type Path = "/login" | "/register";

const emailInput = (page: Page) => page.locator('input[inputmode="email"]');
const passwordInput = (page: Page) => page.locator('input[type="password"]');
const alert = (page: Page) => page.locator('main [role="alert"]');

async function installBoundary(page: Page, language: Language) {
  const calls: unknown[] = [];
  const errors: string[] = [];
  let responseGate = Promise.resolve();
  const appOrigin = new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((lang) => localStorage.setItem("nailiq-user-lang", lang), language);
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      // Fail closed if a wrong keyboard action ever tries to leave for OAuth.
      if (new URL(request.url()).origin !== appOrigin) return route.abort("blockedbyclient");
      return route.continue();
    }
    if (!request.headers()["next-action"]) {
      return route.fulfill({ status: 204, body: "" });
    }
    calls.push(JSON.parse(request.postData() ?? "null") as unknown);
    await responseGate;
    return route.fulfill({
      status: 503,
      contentType: "text/plain; charset=utf-8",
      body: "QA interrupted auth response",
    });
  });
  return {
    calls,
    errors,
    holdResponses() {
      let release!: () => void;
      responseGate = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
  };
}

async function open(page: Page, path: Path) {
  await page.goto(path);
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByTestId("password-signin-submit")).toBeEnabled();
}

async function fillDraft(page: Page, value = password) {
  await emailInput(page).fill(email);
  await passwordInput(page).fill(value);
}

async function expectRecovered(page: Page, language: Language, value = password) {
  await expect(alert(page)).toHaveText(copy[language].failed);
  await expect(emailInput(page)).toHaveValue(email);
  await expect(passwordInput(page)).toHaveValue(value);
  await expect(page.getByTestId("password-signin-submit")).toBeEnabled();
}

async function finishKeyboardEvents(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

for (const language of ["en", "vi"] as const) {
  for (const path of ["/login", "/register"] as const) {
    test(`${language} ${path}: Enter from email and password submits only the primary action`, async ({ page }) => {
      const boundary = await installBoundary(page, language);
      const action = path === "/login" ? "signin" : "signup";
      await open(page, path);
      await fillDraft(page);
      for (const input of [emailInput(page), passwordInput(page)]) {
        const before = boundary.calls.length;
        await input.press("Enter");
        await expect.poll(() => boundary.calls.length).toBe(before + 1);
        await expectRecovered(page, language);
        expect(boundary.calls[before]).toEqual([email, password, action]);
        expect(boundary.calls).toHaveLength(before + 1);
        expect(new URL(page.url()).pathname).toBe(path);
      }
      expect(boundary.errors).toEqual([]);
    });
  }

  test(`${language}: weak signup stays blocked while secondary sign-in accepts a short password`, async ({ page }) => {
    const boundary = await installBoundary(page, language);
    await open(page, "/register");
    for (const value of ["abc", "alllowercase"]) {
      await fillDraft(page, value);
      await expect(page.getByTestId("password-signup-submit")).toBeDisabled();
      await passwordInput(page).press("Enter");
      await finishKeyboardEvents(page);
      expect(boundary.calls).toEqual([]);
    }
    await passwordInput(page).fill("abc");
    await page.getByTestId("password-signin-submit").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => boundary.calls.length).toBe(1);
    await expectRecovered(page, language, "abc");
    expect(boundary.calls).toEqual([[email, "abc", "signin"]]);
    expect(boundary.errors).toEqual([]);
  });

  test(`${language}: primary sign-in accepts a short password through Enter`, async ({ page }) => {
    const boundary = await installBoundary(page, language);
    await open(page, "/login");
    await fillDraft(page, "abc");
    await passwordInput(page).press("Enter");
    await expect.poll(() => boundary.calls.length).toBe(1);
    await expectRecovered(page, language, "abc");
    expect(boundary.calls).toEqual([[email, "abc", "signin"]]);
    expect(boundary.errors).toEqual([]);
  });

  test(`${language}: Enter on secondary signup and forgot-password keeps the focused action`, async ({ page }) => {
    const boundary = await installBoundary(page, language);
    await open(page, "/login");
    await fillDraft(page);
    await page.getByTestId("password-signup-submit").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => boundary.calls.length).toBe(1);
    await expectRecovered(page, language);
    expect(boundary.calls).toEqual([[email, password, "signup"]]);
    await page.getByRole("button", { name: copy[language].magic, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => boundary.calls.length).toBe(2);
    await expectRecovered(page, language);
    expect(boundary.calls).toEqual([[email, password, "signup"], [email]]);
    expect(boundary.errors).toEqual([]);
  });

  test(`${language}: Enter sends only a magic link after opening email-only mode`, async ({ page }) => {
    const boundary = await installBoundary(page, language);
    for (const path of ["/login", "/register"] as const) {
      await open(page, path);
      const before = boundary.calls.length;
      await emailInput(page).fill("not-an-email");
      await page.getByRole("button", { name: copy[language].magic, exact: true }).click();
      await expect(passwordInput(page)).toHaveCount(0);
      await expect(alert(page)).toHaveText(copy[language].emailInvalid);
      expect(boundary.calls).toHaveLength(before);
      // The field must now belong to the visible magic-link submission flow.
      await emailInput(page).fill(email);
      await emailInput(page).press("Enter");
      await expect.poll(() => boundary.calls.length).toBe(before + 1);
      await expect(alert(page)).toHaveText(copy[language].failed);
      await expect(emailInput(page)).toHaveValue(email);
      await expect(passwordInput(page)).toHaveCount(0);
      expect(boundary.calls[before]).toEqual([email]);
      expect(boundary.calls).toHaveLength(before + 1);
      expect(new URL(page.url()).pathname).toBe(path);
      expect(boundary.errors).toEqual([]);
    }
  });

  test(`${language}: repeated Enter while a password request is pending does not resubmit`, async ({ page }) => {
    const boundary = await installBoundary(page, language);
    await open(page, "/login");
    await fillDraft(page);
    const release = boundary.holdResponses();
    try {
      await passwordInput(page).press("Enter");
      await expect.poll(() => boundary.calls.length).toBe(1);
      await expect(page.getByTestId("password-signin-submit")).toBeDisabled();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await finishKeyboardEvents(page);
      expect(boundary.calls).toHaveLength(1);
    } finally {
      release();
    }
    await expectRecovered(page, language);
    expect(boundary.calls).toEqual([[email, password, "signin"]]);
    expect(boundary.errors).toEqual([]);
  });

  test(`${language}: Enter keeps localized email and password validation without sending a request`, async ({ page }) => {
    const boundary = await installBoundary(page, language);
    await open(page, "/login");
    await emailInput(page).fill("not-an-email");
    await passwordInput(page).fill(password);
    await emailInput(page).press("Enter");
    await expect(alert(page)).toHaveText(copy[language].emailRequired);
    await emailInput(page).fill(email);
    await passwordInput(page).fill("");
    await passwordInput(page).press("Enter");
    await expect(alert(page)).toHaveText(copy[language].passwordRequired);
    expect(boundary.calls).toEqual([]);
    expect(boundary.errors).toEqual([]);
  });
}
