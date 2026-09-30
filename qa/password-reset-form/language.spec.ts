import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { assertInertFixture } from "./assert-inert-fixture";

// Real components and language provider, with inert action replacements and
// every mutation intercepted. None of these tests contacts an Auth provider.
assertInertFixture();
const origin = "http://127.0.0.1:3113";
const buildId = readFileSync("qa/password-reset-form/.next/BUILD_ID", "utf8").trim();
const email = "language.fixture@example.test";
const password = "FixtureOnly9!";
type Language = "en" | "vi";
const languages = ["en", "vi"] as const;
const routes = ["/", "/superadmin", "/operator-login", "/operator-forgot"] as const;
type Surface = typeof routes[number];
const copy = {
  en: {
    titles: ["Create a new password", "Set a new password", "SuperAdmin sign-in", "Reset SuperAdmin password"],
    submit: ["Set new password", "Set new password", "Sign in", "Send reset link"],
    password: "Password", newPassword: "New password", confirmPassword: "Confirm password",
    failed: "Sign-in failed.", serverError: "Something went wrong. Try again.",
    sentTitle: "Check your inbox",
    sentBody: "If the account is eligible, a password-reset link is on its way.",
    back: "Back to sign in",
    unconfirmed: "We could not confirm whether your password changed. Try signing in with your new password. If it does not work, request a new reset link.",
  },
  vi: {
    titles: ["Tạo mật khẩu mới", "Đặt mật khẩu mới", "Đăng nhập SuperAdmin", "Đặt lại mật khẩu SuperAdmin"],
    submit: ["Đặt mật khẩu mới", "Đặt mật khẩu mới", "Đăng nhập", "Gửi link đặt lại"],
    password: "Mật khẩu", newPassword: "Mật khẩu mới", confirmPassword: "Xác nhận mật khẩu",
    failed: "Đăng nhập không thành công.", serverError: "Có lỗi xảy ra. Vui lòng thử lại.",
    sentTitle: "Kiểm tra hộp thư",
    sentBody: "Nếu tài khoản đủ điều kiện, link đặt lại mật khẩu đang được gửi.",
    back: "Quay lại đăng nhập",
    unconfirmed: "Chưa thể xác nhận mật khẩu đã được đổi. Hãy thử đăng nhập bằng mật khẩu mới. Nếu không đăng nhập được, hãy yêu cầu link đặt lại mới.",
  },
};
const diagnostics = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  diagnostics.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /hydration|Minified React|didn't match|server rendered/i.test(message.text())) errors.push(message.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(diagnostics.get(page), "No browser or hydration errors").toEqual([]);
});

async function boundary(page: Page, language: Language, options: { holdScripts?: boolean; storedLanguage?: Language } = {}) {
  const state = { calls: 0, result: { ok: false, error: "server_error" } as { ok: boolean; error?: string }, transportFailure: false, holdResponse: Promise.resolve() };
  let releaseScripts!: () => void;
  const scripts = new Promise<void>(resolve => { releaseScripts = resolve; });
  if (!options.holdScripts) releaseScripts();
  await page.context().addCookies([{ name: "nailiq-user-lang", value: language, url: origin }]);
  await page.addInitScript(lang => localStorage.setItem("nailiq-user-lang", lang), options.storedLanguage ?? language);
  await page.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      diagnostics.get(page)!.push(`Unexpected external request: ${url.origin}`);
      return route.abort("blockedbyclient");
    }
    if (!["GET", "HEAD"].includes(request.method())) {
      if (!request.headers()["next-action"]) return route.fulfill({ status: 204, body: "" });
      state.calls++;
      await state.holdResponse;
      if (state.transportFailure) return route.fulfill({ status: 503, body: "Fixture transport failure" });
      return route.fulfill({ contentType: "text/x-component", body: `0:${JSON.stringify({ a: "$@1", f: "", q: "", i: false, b: buildId })}\n1:${JSON.stringify(state.result)}\n` });
    }
    if (request.resourceType() === "script" && url.pathname.startsWith("/_next/static/")) await scripts;
    return route.continue();
  });
  return { state, releaseScripts };
}

async function assertLabels(page: Page, path: Surface, language: Language) {
  const index = routes.indexOf(path);
  const main = page.locator("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(copy[language].titles[index]);
  await expect(main.getByRole("button")).toHaveText(copy[language].submit[index]);
  const labels = path === "/" || path === "/superadmin"
    ? [copy[language].newPassword, copy[language].confirmPassword]
    : path === "/operator-login" ? ["Email", copy[language].password] : ["Email"];
  for (let i = 0; i < labels.length; i++) {
    const label = main.locator("label").nth(i);
    // The owner's strength hint also contributes to the accessible name after
    // typing. Check the primary label and its associated input separately.
    await expect(label.locator(":scope > span")).toHaveText(labels[i]);
    await expect(label.locator("input")).toBeVisible();
  }
}

async function fillDraft(page: Page, path: Surface) {
  const inputs = page.locator("main input");
  const values = path === "/operator-forgot" ? [email] : path === "/operator-login" ? [email, password] : [password, password];
  for (let i = 0; i < values.length; i++) await inputs.nth(i).fill(values[i]);
  return async () => {
    for (let i = 0; i < values.length; i++) await expect(inputs.nth(i)).toHaveValue(values[i]);
  };
}

async function switchLanguage(page: Page, language: Language) {
  await page.getByTestId(`fixture-lang-${language}`).click();
  await expect(page.locator("html")).toHaveAttribute("lang", language);
}

for (const [path, expected] of [["/operator-login", "Đăng nhập"], ["/operator-forgot", "Gửi link đặt lại"], ["/superadmin", "Đặt mật khẩu mới"]]) {
  test(`Vietnamese-only submit copy ${path}`, async ({ page }) => {
    await boundary(page, "vi");
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("lang", "vi");
    await expect(page.locator("main").getByRole("button")).toHaveText(expected);
  });
}

for (const path of routes) {
  for (const language of languages) {
    test(`first paint and hydrated labels ${path} ${language}`, async ({ page }, info) => {
      const probe = await boundary(page, language, { holdScripts: true });
      try {
        await page.goto(path, { waitUntil: "commit" });
        await assertLabels(page, path, language);
        probe.releaseScripts();
        await page.waitForLoadState("load");
        await switchLanguage(page, language);
        await assertLabels(page, path, language);
        expect(probe.state.calls).toBe(0);
        await page.locator("main").screenshot({ path: info.outputPath("localized-form.png") });
      } finally {
        probe.releaseScripts();
        await page.waitForLoadState("load");
      }
    });
  }
  test(`saved-language mismatch and live switch preserve the draft ${path}`, async ({ page }) => {
    const probe = await boundary(page, "en", { holdScripts: true, storedLanguage: "vi" });
    try {
      await page.goto(path, { waitUntil: "commit" });
      await assertLabels(page, path, "en");
      probe.releaseScripts();
      await expect(page.locator("html")).toHaveAttribute("lang", "vi");
      await assertLabels(page, path, "vi");
      const assertDraft = await fillDraft(page, path);
      const colors = () => page.locator("main h1, main header p.text-sm, main button").evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      }));
      const vietnameseColors = await colors();
      await switchLanguage(page, "en");
      await assertLabels(page, path, "en");
      await assertDraft();
      expect(await colors()).toEqual(vietnameseColors);
      expect(probe.state.calls).toBe(0);
    } finally {
      probe.releaseScripts();
      await page.waitForLoadState("load");
    }
  });
}

const notices = [
  { path: "/operator-login?reset=ok", role: "status", en: "Password updatedSign in with your new password.", vi: "Mật khẩu đã được cập nhậtĐăng nhập bằng mật khẩu mới." },
  { path: "/operator-login?notice=reauthentication_required", role: "status", en: "Your secure session ended or could not be verified. Sign in again to continue.", vi: "Phiên đăng nhập đã kết thúc hoặc chưa thể xác minh. Vui lòng đăng nhập lại để tiếp tục." },
  { path: "/operator-forgot?notice=invalid_or_expired", role: "alert", en: "Reset link is invalid or expired. Request a new one.", vi: "Link đặt lại không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu link mới." },
  { path: "/operator-forgot?notice=temporarily_unavailable", role: "alert", en: "Password recovery is temporarily unavailable. Try again.", vi: "Tạm thời chưa thể khôi phục mật khẩu. Vui lòng thử lại." },
] as const;
for (const notice of notices) {
  for (const language of languages) {
    test(`notice ${notice.path} ${language} follows the shared language`, async ({ page }, info) => {
      const probe = await boundary(page, language);
      await page.goto(notice.path);
      const banner = page.locator("main").getByRole(notice.role);
      await expect(banner).toHaveText(notice[language]);
      const next = language === "en" ? "vi" : "en";
      await switchLanguage(page, next);
      await expect(banner).toHaveText(notice[next]);
      expect(probe.state.calls).toBe(0);
      await page.locator("main").screenshot({ path: info.outputPath("localized-notice.png") });
    });
  }
}

for (const language of languages) {
  const next = language === "en" ? "vi" : "en";
  for (const error of ["invalid_credentials", "no_role", "server_error"] as const) {
    test(`login ${error} ${language} translates the existing error without another request`, async ({ page }) => {
      const probe = await boundary(page, language);
      probe.state.result = { ok: false, error };
      await page.goto("/operator-login");
      const assertDraft = await fillDraft(page, "/operator-login");
      const form = page.getByTestId("superadmin-login-form");
      await form.getByRole("button").click();
      const key = error === "server_error" ? "serverError" : "failed";
      await expect(form.getByRole("alert")).toHaveText(copy[language][key]);
      await switchLanguage(page, next);
      await expect(form.getByRole("alert")).toHaveText(copy[next][key]);
      await assertDraft();
      expect(probe.state.calls).toBe(1);
      await expect(form.getByRole("link")).toHaveAttribute("href", "/superadmin/forgot-password");
    });
  }
  test(`pending login ${language} uses the language selected before the response arrives`, async ({ page }) => {
    const probe = await boundary(page, language);
    let release!: () => void;
    probe.state.holdResponse = new Promise<void>(resolve => { release = resolve; });
    try {
      await page.goto("/operator-login");
      const assertDraft = await fillDraft(page, "/operator-login");
      const form = page.getByTestId("superadmin-login-form");
      await form.getByRole("button").click();
      await expect.poll(() => probe.state.calls).toBe(1);
      await expect(form.getByRole("button")).toBeDisabled();
      await switchLanguage(page, next);
      await expect(form.getByRole("button")).toBeDisabled();
      release();
      await expect(form.getByRole("alert")).toHaveText(copy[next].serverError);
      await assertDraft();
      expect(probe.state.calls).toBe(1);
    } finally { release(); }
  });
  for (const ok of [false, true]) {
    test(`forgot-password ${ok ? "sent" : "error"} ${language} follows a language switch`, async ({ page }) => {
      const probe = await boundary(page, language);
      probe.state.result = ok ? { ok: true } : { ok: false, error: "server_error" };
      await page.goto("/operator-forgot");
      const assertDraft = await fillDraft(page, "/operator-forgot");
      await page.locator("main").getByRole("button").click();
      if (ok) {
        const sent = page.getByTestId("superadmin-forgot-password-sent");
        await expect(sent).toContainText(copy[language].sentBody);
        await switchLanguage(page, next);
        await expect(sent).toContainText(copy[next].sentTitle);
        await expect(sent).toContainText(copy[next].sentBody);
        await expect(sent.getByRole("link", { name: copy[next].back })).toHaveAttribute("href", "/superadmin/login");
      } else {
        const alert = page.locator("main").getByRole("alert");
        await expect(alert).toHaveText(copy[language].serverError);
        await switchLanguage(page, next);
        await expect(alert).toHaveText(copy[next].serverError);
        await assertDraft();
      }
      expect(probe.state.calls).toBe(1);
    });
  }
  test(`unconfirmed SuperAdmin reset ${language} retains both passwords when translated`, async ({ page }) => {
    const probe = await boundary(page, language);
    probe.state.transportFailure = true;
    await page.goto("/superadmin");
    const assertDraft = await fillDraft(page, "/superadmin");
    const form = page.getByTestId("superadmin-reset-password-form");
    await form.getByRole("button").click();
    await expect(form.getByRole("alert")).toHaveText(copy[language].unconfirmed);
    await switchLanguage(page, next);
    await expect(form.getByRole("alert")).toHaveText(copy[next].unconfirmed);
    await assertDraft();
    await expect(form.getByRole("link", { name: copy[next].back })).toHaveAttribute("href", "/superadmin/login");
    expect(probe.state.calls).toBe(1);
  });
}

for (const path of routes) {
  test(`320px Vietnamese ${path}: long error copy stays within the form and uses its error color`, async ({ page }, info) => {
    await page.setViewportSize({ width: 320, height: 740 });
    const probe = await boundary(page, "vi");
    const reset = path === "/" || path === "/superadmin";
    probe.state.transportFailure = reset;
    await page.goto(path);
    await fillDraft(page, path);
    const main = page.locator("main");
    const button = main.getByRole("button");
    await button.click();
    const alert = main.getByRole("alert");
    await expect(alert).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const color = await alert.evaluate(el => getComputedStyle(el).color);
    for (const input of await main.locator("input").all()) await expect(input).toHaveCSS("border-top-color", color);
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await main.screenshot({ path: info.outputPath("vietnamese-320px-error.png") });
    expect(probe.state.calls).toBe(1);
  });
}
