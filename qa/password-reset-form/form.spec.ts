import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext } from "@playwright/test";
import { assertInertFixture } from "./assert-inert-fixture";

// Real React component + Next action decoder in an isolated fixture, not a
// bypass of the protected production page. Every POST is intercepted.
assertInertFixture();
const buildId = readFileSync("qa/password-reset-form/.next/BUILD_ID", "utf8").trim();
const password = "QA-Only-Password-42";
const copy = {
  en: {
    unconfirmed: "We could not confirm whether your password changed. Try signing in with your new password. If it does not work, request a new reset link.",
    server_error: "Something went wrong. Try again.",
    no_session: "This reset link has expired. Request a new one.",
    no_salon_member: "This account is no longer associated with a salon.",
    weak_password: "Password must be at least 8 characters.",
    mismatch: "Passwords don't match.",
    back: "Back to sign in",
  },
  vi: {
    unconfirmed: "Chưa thể xác nhận mật khẩu đã được đổi. Hãy thử đăng nhập bằng mật khẩu mới. Nếu không đăng nhập được, hãy yêu cầu link đặt lại mới.",
    server_error: "Có lỗi xảy ra. Thử lại.",
    no_session: "Link đặt lại này đã hết hạn. Yêu cầu một cái mới.",
    no_salon_member: "Tài khoản này không còn thuộc salon nào.",
    weak_password: "Mật khẩu phải có ít nhất 8 ký tự.",
    mismatch: "Mật khẩu không khớp.",
    back: "Quay lại đăng nhập",
  },
};
const faults = ["429", "503", "abort", "server_error", "no_session", "no_salon_member", "weak_password"] as const;
type Fault = typeof faults[number] | "no_role";
async function intercept(context: BrowserContext, fault: Fault) {
  const state = { calls: 0, acknowledge: false, hold: null as Promise<void> | null };
  await context.route("**/*", async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== "http://127.0.0.1:3113") return route.abort("blockedbyclient");
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    if (!request.headers()["next-action"]) return route.fulfill({ status: 204, body: "" });
    state.calls++;
    if (state.hold) await state.hold;
    if (!state.acknowledge && fault === "abort") return route.abort("failed");
    if (!state.acknowledge && (fault === "429" || fault === "503")) {
      return route.fulfill({ status: Number(fault), contentType: "text/plain", body: "QA private transport detail" });
    }
    const result = state.acknowledge ? { ok: true } : { ok: false, error: fault };
    return route.fulfill({ contentType: "text/x-component",
      body: `0:${JSON.stringify({ a: "$@1", f: "", q: "", i: false, b: buildId })}\n1:${JSON.stringify(result)}\n` });
  });
  return state;
}
for (const language of ["en", "vi"] as const) {
  test.describe(language, () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(lang => localStorage.setItem("nailiq-user-lang", lang), language);
  });
  for (const fault of faults) {
    test(`${language} ${fault}: preserve both passwords and require an acknowledged explicit retry`, async ({ page, context }, info) => {
      const state = await intercept(context, fault);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("/");
      const form = page.getByTestId("salon-owner-reset-password-form");
      const fields = form.locator("input");
      const submit = form.getByRole("button", { name: language === "en" ? "Set new password" : "Đặt mật khẩu mới", exact: true });
      await fields.nth(0).fill(password);
      await fields.nth(1).fill(password);
      await submit.click();
      const transport = ["429", "503", "abort"].includes(fault);
      await expect(form.getByRole("alert")).toHaveText(transport ? copy[language].unconfirmed : copy[language][fault as keyof typeof copy.en]);
      for (const field of await fields.all()) {
        await expect(field).toHaveValue(password);
        await expect(field).toHaveAttribute("aria-invalid", "true");
      }
      await expect(submit).toBeEnabled();
      expect(state.calls).toBe(1);
      expect(new URL(page.url()).pathname).toBe("/");
      expect(errors).toEqual([]);
      await expect(page.getByTestId("fixture-error-boundary")).toHaveCount(0);
      await expect(page.getByText("QA private transport detail")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const alertColor = await form.getByRole("alert").evaluate(el => getComputedStyle(el).color);
      await expect(fields.first()).toHaveCSS("border-top-color", alertColor);
      if (transport) await expect(form.getByRole("link", { name: copy[language].back })).toHaveAttribute("href", "/login");
      if (fault === "abort") await page.screenshot({ path: info.outputPath("unconfirmed.png"), fullPage: true });
      await fields.nth(1).fill(password + "X");
      await expect(form.getByRole("alert")).toHaveCount(0);
      expect(state.calls).toBe(1);
      await fields.nth(0).fill(password + "X");
      state.acknowledge = true;
      await submit.click();
      await expect(page).toHaveURL("http://127.0.0.1:3113/login?reset=ok");
      expect(state.calls).toBe(2);
      expect(errors).toEqual([]);
    });
  }
  test(`${language} validation blocks mismatched and short passwords without a request`, async ({ page, context }) => {
    const state = await intercept(context, "503");
    await page.goto("/");
    const form = page.getByTestId("salon-owner-reset-password-form");
    const fields = form.locator("input");
    const submit = form.getByRole("button");
    await expect(submit).toBeDisabled();
    await fields.nth(0).fill("short");
    await fields.nth(1).fill("short");
    await expect(submit).toBeDisabled();
    await fields.nth(0).fill(password);
    await submit.click();
    await expect(form.getByRole("alert")).toHaveText(copy[language].mismatch);
    expect(state.calls).toBe(0);
  });
  test(`${language} unconfirmed password can return to sign in without success notice or another mutation`, async ({ page, context }) => {
    const state = await intercept(context, "abort");
    await page.goto("/");
    const form = page.getByTestId("salon-owner-reset-password-form");
    for (const field of await form.locator("input").all()) await field.fill(password);
    await form.getByRole("button").click();
    await form.getByRole("link", { name: copy[language].back }).click();
    await expect(page).toHaveURL("http://127.0.0.1:3113/login");
    expect(state.calls).toBe(1);
  });
  test(`${language} pending request blocks repeated submission until its response arrives`, async ({ page, context }) => {
    const state = await intercept(context, "abort");
    let release!: () => void;
    state.hold = new Promise<void>(resolve => { release = resolve; });
    try {
      await page.goto("/");
      const form = page.getByTestId("salon-owner-reset-password-form");
      for (const field of await form.locator("input").all()) await field.fill(password);
      await form.getByRole("button").click();
      await expect(form.getByRole("button")).toBeDisabled();
      await form.locator("input").last().press("Enter");
      expect(state.calls).toBe(1);
      release();
      await expect(form.getByRole("alert")).toHaveText(copy[language].unconfirmed);
      await expect(form.getByRole("button")).toBeEnabled();
      expect(state.calls).toBe(1);
    } finally {
      release();
    }
  });
  });
}

const superadminCopy = {
  unconfirmed: `${copy.en.unconfirmed} / ${copy.vi.unconfirmed}`,
  server_error: "Something went wrong. Try again. / Có lỗi xảy ra. Vui lòng thử lại.",
  no_session: "Reset link is no longer valid. Request a new one. / Link đặt lại không còn hiệu lực. Vui lòng yêu cầu link mới.",
  no_role: "This account is not an active SuperAdmin. / Tài khoản này không phải SuperAdmin đang hoạt động.",
  weak_password: "Password must be 8–72 characters. / Mật khẩu phải có 8–72 ký tự.",
  mismatch: "Passwords don't match. / Mật khẩu không khớp.",
};
const superadminBack = "Back to sign in / Quay lại đăng nhập";
test.describe("SuperAdmin bilingual form", () => {
  for (const fault of ["429", "503", "abort", "server_error", "no_session", "no_role", "weak_password"] as const) {
    test(`${fault}: preserve form and only navigate after acknowledged retry`, async ({ page, context }, info) => {
      const state = await intercept(context, fault);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("/superadmin");
      const form = page.getByTestId("superadmin-reset-password-form");
      const fields = form.locator("input");
      for (const field of await fields.all()) await field.fill(password);
      await form.getByRole("button").click();
      const transport = ["429", "503", "abort"].includes(fault);
      await expect(form.getByRole("alert")).toHaveText(transport ? superadminCopy.unconfirmed : superadminCopy[fault as keyof typeof superadminCopy]);
      for (const field of await fields.all()) {
        await expect(field).toHaveValue(password);
        await expect(field).toHaveAttribute("aria-invalid", "true");
      }
      await expect(form.getByRole("button")).toBeEnabled();
      expect(state.calls).toBe(1);
      await expect(page).toHaveURL("http://127.0.0.1:3113/superadmin");
      expect(errors).toEqual([]);
      await expect(page.getByTestId("fixture-error-boundary")).toHaveCount(0);
      await expect(page.getByText("QA private transport detail")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const alertColor = await form.getByRole("alert").evaluate(el => getComputedStyle(el).color);
      await expect(fields.first()).toHaveCSS("border-top-color", alertColor);
      if (transport) {
        const back = form.getByRole("link", { name: superadminBack });
        await expect(back).toHaveAttribute("href", "/superadmin/login");
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      } else await expect(form.getByRole("link")).toHaveCount(0);
      if (fault === "abort") await page.screenshot({ path: info.outputPath("superadmin-unconfirmed.png"), fullPage: true });
      await fields.nth(1).fill(password + "X");
      await expect(form.getByRole("alert")).toHaveCount(0);
      expect(state.calls).toBe(1);
      await fields.nth(0).fill(password + "X");
      state.acknowledge = true;
      await form.getByRole("button").click();
      await expect(page).toHaveURL("http://127.0.0.1:3113/superadmin/login?reset=ok");
      expect(state.calls).toBe(2);
      expect(errors).toEqual([]);
    });
  }
  test("validation blocks empty, short and mismatched passwords", async ({ page, context }) => {
    const state = await intercept(context, "503");
    await page.goto("/superadmin");
    const form = page.getByTestId("superadmin-reset-password-form");
    const fields = form.locator("input");
    await form.getByRole("button").click();
    await expect(form.getByRole("alert")).toHaveText(superadminCopy.weak_password);
    for (const field of await fields.all()) {
      await expect(field).toHaveAttribute("maxlength", "72");
      await field.fill("short");
    }
    await form.getByRole("button").click();
    await expect(form.getByRole("alert")).toHaveText(superadminCopy.weak_password);
    await fields.first().fill(password);
    await form.getByRole("button").click();
    await expect(form.getByRole("alert")).toHaveText(superadminCopy.mismatch);
    expect(state.calls).toBe(0);
  });
  test("unconfirmed password returns to SuperAdmin sign in without success or mutation", async ({ page, context }) => {
    const state = await intercept(context, "abort");
    await page.goto("/superadmin");
    const form = page.getByTestId("superadmin-reset-password-form");
    for (const field of await form.locator("input").all()) await field.fill(password);
    await form.getByRole("button").click();
    await form.getByRole("link", { name: superadminBack }).click();
    await expect(page).toHaveURL("http://127.0.0.1:3113/superadmin/login");
    expect(state.calls).toBe(1);
  });
  test("pending request blocks repeated submission", async ({ page, context }) => {
    const state = await intercept(context, "abort");
    let release!: () => void;
    state.hold = new Promise<void>(resolve => { release = resolve; });
    try {
      await page.goto("/superadmin");
      const form = page.getByTestId("superadmin-reset-password-form");
      for (const field of await form.locator("input").all()) await field.fill(password);
      await form.getByRole("button").click();
      await expect(form.getByRole("button")).toBeDisabled();
      await form.locator("input").last().press("Enter");
      expect(state.calls).toBe(1);
      release();
      await expect(form.getByRole("alert")).toHaveText(superadminCopy.unconfirmed);
      await expect(form.getByRole("button")).toBeEnabled();
      expect(state.calls).toBe(1);
    } finally { release(); }
  });
});

// Hold application chunks so the user-visible server HTML is tested before
// React attaches handlers. Never forward a password action to the fixture.
test("SuperAdmin waits for hydration before accepting password input", async ({ page, context }) => {
  const state = await intercept(context, "abort");
  let release!: () => void;
  const scriptsReady = new Promise<void>(resolve => { release = resolve; });
  await context.route("**/*", async route => {
    if (route.request().resourceType() === "script") await scriptsReady;
    return route.fallback();
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto("/superadmin", { waitUntil: "commit" });
    const form = page.getByTestId("superadmin-reset-password-form");
    const fields = form.locator("input");
    await expect(fields).toHaveCount(2);
    await expect(fields.first()).toBeDisabled();
    await expect(fields.last()).toBeDisabled();
    await expect(form.getByRole("button")).toBeDisabled();
    expect(state.calls).toBe(0);
    release();
    await expect(fields.first()).toBeEnabled();
    await expect(fields.last()).toBeEnabled();
    await fields.first().fill(password);
    await fields.last().fill(password);
    await expect(fields.first()).toHaveValue(password);
    await expect(fields.last()).toHaveValue(password);
    await form.getByRole("button").click();
    await expect(form.getByRole("alert")).toHaveText(superadminCopy.unconfirmed);
    expect(state.calls).toBe(1);
    await expect(fields.first()).toHaveValue(password);
    await expect(fields.last()).toHaveValue(password);
    expect(errors).toEqual([]);
  } finally { release(); }
});
