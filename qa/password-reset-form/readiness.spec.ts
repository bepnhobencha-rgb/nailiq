import { expect, test, type Page } from "@playwright/test";
import { assertInertFixture } from "./assert-inert-fixture";

assertInertFixture();

const email = "fixture.auth@example.test";
const password = "FixtureOnly9!";
const failure = {
  en: "We could not confirm whether your request completed. Wait a few minutes, then try again.",
  vi: "Chưa thể xác nhận yêu cầu đã hoàn tất. Hãy đợi vài phút rồi thử lại.",
};
type Language = keyof typeof failure;
type Surface = "login" | "register" | "email" | "compact";
const emailInput = (page: Page) => page.locator('input[type="email"]');
const passwordInput = (page: Page) => page.locator('input[type="password"]');
const controls = (page: Page) => page.getByTestId("social-auth-controls");

async function boundary(page: Page, language: Language) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const calls: unknown[] = [];
  const errors: string[] = [];
  let releaseScripts!: () => void;
  const scripts = new Promise<void>((resolve) => { releaseScripts = resolve; });
  let responses = Promise.resolve();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((lang) => localStorage.setItem("nailiq-user-lang", lang), language);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (!["GET", "HEAD"].includes(request.method())) {
      if (request.headers()["next-action"]) calls.push(JSON.parse(request.postData()!));
      await responses;
      return route.fulfill({ status: 503, contentType: "text/plain", body: "QA interrupted response" });
    }
    if (url.pathname.startsWith("/_next/static/") && request.resourceType() === "script") {
      await scripts;
    }
    return route.continue();
  });
  return {
    calls,
    errors,
    releaseScripts,
    holdResponses() {
      let release!: () => void;
      responses = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
  };
}

async function recover(page: Page, language: Language, hasPassword: boolean) {
  await expect(controls(page).getByRole("alert")).toHaveText(failure[language]);
  await expect(emailInput(page)).toHaveValue(email);
  if (hasPassword) await expect(passwordInput(page)).toHaveValue(password);
}

for (const language of ["en", "vi"] as const) {
  for (const surface of ["login", "register", "email"] as const) {
    test(`delayed scripts: ${surface} ${language} accepts a draft only when its handlers are ready`, async ({ page }) => {
      const probe = await boundary(page, language);
      const hasPassword = surface !== "email";
      try {
        await page.goto(`/auth?surface=${surface}`, { waitUntil: "commit" });
        await expect(controls(page)).toHaveAttribute("data-hydrated", "false");
        await expect(emailInput(page)).toBeVisible();
        await expect(emailInput(page)).toBeDisabled({ timeout: 1000 });
        if (hasPassword) await expect(passwordInput(page)).toBeDisabled();
        await page.keyboard.press("Tab");
        await page.keyboard.type("too-early");
        await page.keyboard.press("Enter");
        await expect(emailInput(page)).toHaveValue("");
        expect(probe.calls).toEqual([]);

        // Start typing without a test-side hydration wait: the real disabled
        // field must make browser actionability wait until it can accept input.
        const filling = emailInput(page).fill(email);
        probe.releaseScripts();
        await filling;
        await expect(controls(page)).toHaveAttribute("data-hydrated", "true");
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        if (hasPassword) {
          await expect(passwordInput(page)).toHaveAttribute("autocomplete", surface === "register" ? "new-password" : "current-password");
          await passwordInput(page).fill(password);
          await passwordInput(page).press("Enter");
        } else {
          await emailInput(page).press("Enter");
        }
        await expect.poll(() => probe.calls.length).toBe(1);
        expect(probe.calls).toEqual([hasPassword ? [email, password, surface === "register" ? "signup" : "signin"] : [email]]);
        await recover(page, language, hasPassword);
        expect(probe.errors).toEqual([]);
        expect(new URL(page.url()).pathname).toBe("/auth");
      } finally {
        probe.releaseScripts();
        await page.waitForLoadState("load");
      }
    });
  }

  test(`compact ${language}: email autofocus and Enter still work after opening the ready form`, async ({ page }) => {
    const probe = await boundary(page, language);
    try {
      await page.goto("/auth?surface=compact", { waitUntil: "commit" });
      const toggle = page.getByTestId("social-auth-other-options-toggle");
      await expect(toggle).toBeDisabled();
      await expect(emailInput(page)).toHaveCount(0);
      probe.releaseScripts();
      await toggle.click();
      await expect(emailInput(page)).toBeEnabled();
      await expect(emailInput(page)).toBeFocused();
      await emailInput(page).fill(email);
      await emailInput(page).press("Enter");
      await recover(page, language, false);
      expect(probe.calls).toEqual([[email]]);
      expect(probe.errors).toEqual([]);
    } finally {
      probe.releaseScripts();
      await page.waitForLoadState("load");
    }
  });

  test(`pending ${language}: repeated Enter preserves one request and the draft after a lost response`, async ({ page }) => {
    const probe = await boundary(page, language);
    probe.releaseScripts();
    await page.goto("/auth?surface=login");
    await emailInput(page).fill(email);
    await passwordInput(page).fill(password);
    const release = probe.holdResponses();
    try {
      await passwordInput(page).press("Enter");
      await expect.poll(() => probe.calls.length).toBe(1);
      await expect(page.getByTestId("password-signin-submit")).toBeDisabled();
      await passwordInput(page).press("Enter");
      await emailInput(page).press("Enter");
      expect(probe.calls).toEqual([[email, password, "signin"]]);
    } finally {
      release();
    }
    await recover(page, language, true);
    expect(probe.calls).toHaveLength(1);
    expect(probe.errors).toEqual([]);
  });
}

test.describe("JavaScript unavailable", () => {
  test.use({ javaScriptEnabled: false });
  for (const surface of ["login", "register", "email"] satisfies Surface[]) {
    test(`${surface}: static fields stay disabled instead of accepting an unusable draft`, async ({ page }) => {
      await page.goto(`/auth?surface=${surface}`);
      await expect(controls(page)).toHaveAttribute("data-hydrated", "false");
      await expect(emailInput(page)).toBeDisabled();
      if (surface !== "email") await expect(passwordInput(page)).toBeDisabled();
      for (const button of await controls(page).getByRole("button").all()) {
        await expect(button).toBeDisabled();
      }
    });
  }
});
