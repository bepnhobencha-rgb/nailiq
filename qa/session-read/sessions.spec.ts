import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext } from "@playwright/test";
const fixture = "qa/session-read";
const manifest = JSON.parse(readFileSync(`${fixture}/.next/server/server-reference-manifest.json`, "utf8"));
const actions = Object.values(manifest.node) as { filename: string; exportedName: string }[];
if (actions.some(a => !["presenceActions.ts:loadSalonSessions", "setupActions.ts:getDashboardWriteClient"].includes(`${a.filename}:${a.exportedName}`)) || !actions.some(a => a.exportedName === "loadSalonSessions")) throw new Error("Fixture contains unexpected actions");
const actionIds = new Set(Object.keys(manifest.node));
const buildId = readFileSync(`${fixture}/.next/BUILD_ID`, "utf8").trim();
const origin = "http://127.0.0.1:3121";
const messages = {
  en: "Couldn’t load active sessions. Please try again.",
  vi: "Không tải được phiên đang hoạt động. Vui lòng thử lại.",
};
async function guard(context: BrowserContext) {
  const state = { calls: 0, fault: "success", hold: null as Promise<void> | null, blocked: [] as string[] };
  await context.route("**/*", async route => {
    const r = route.request();
    if (new URL(r.url()).origin !== origin) { state.blocked.push(r.url()); return route.abort(); }
    if (["GET", "HEAD"].includes(r.method())) return route.continue();
    if (!actionIds.has(r.headers()["next-action"])) { state.blocked.push(r.method()); return route.abort(); }
    state.calls++;
    if (state.hold) await state.hold;
    if (state.fault === "success") return route.continue();
    if (state.fault === "abort") return route.abort("failed");
    if (state.fault === "503") return route.fulfill({ status: 503, body: "private backend detail" });
    return route.fulfill({ contentType: "text/x-component", body:
      `0:${JSON.stringify({ a: "$@1", f: "", q: "", i: false, b: buildId })}\n1:${JSON.stringify({ ok: false, error: state.fault })}\n` });
  });
  return state;
}
for (const language of ["en", "vi"] as const) {
 test.describe(language, () => {
  test.beforeEach(async ({ page }) => { await page.addInitScript(lang => localStorage.setItem("nailiq-user-lang", lang), language); });
  test(`${language}: initial read error is visible, never an empty success; retry recovers`, async ({ page, context }, info) => {
    const state = await guard(context);
    await context.addCookies([{ name: "qa-initial", value: "error", url: origin }]);
    await page.goto("/");
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveText(messages[language]);
    await expect(page.getByText("No active sessions", { exact: true })).toHaveCount(0);
    await expect(page.getByText("No one online", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("initial-error.png"), fullPage: true });
    await context.clearCookies();
    const retry = page.getByRole("button", { name: /Refresh|Thử lại|Try again|Làm mới/ });
    await retry.focus();
    await retry.press("Enter");
    await expect(page.getByText("QA Owner", { exact: true })).toBeVisible();
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
    expect(state.calls).toBe(1); expect(state.blocked).toEqual([]);
  });
  for (const fault of ["503", "abort", "server_error", "unauthorized", "not_found"]) {
    test(`${language}: ${fault} clears unverified data, stays usable and retries once`, async ({ page, context }, info) => {
      const state = await guard(context); const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.goto("/");
      await expect(page.getByText("QA Owner", { exact: true })).toBeVisible();
      state.fault = fault;
      let release!: () => void;
      state.hold = new Promise<void>(resolve => { release = resolve; });
      const button = page.getByRole("button", { name: /Refresh|Thử lại|Try again|Làm mới/ });
      try { await button.click(); await expect(button).toBeDisabled(); await expect.poll(() => state.calls).toBe(1); }
      finally { release(); }
      const denied = fault === "unauthorized" || fault === "not_found";
      await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveText(denied
        ? (language === "en" ? "Session access is unavailable. Sign in again or ask the salon owner." : "Không thể xem phiên đăng nhập. Hãy đăng nhập lại hoặc liên hệ chủ salon.")
        : messages[language]);
      await expect(page.getByText("QA Owner", { exact: true })).toHaveCount(0);
      await expect(page.getByText("qa@example.invalid", { exact: true })).toHaveCount(0);
      await expect(page.getByText("No active sessions", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("fixture-error")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await expect(button).toBeEnabled();
      if (fault === "abort") await page.screenshot({ path: info.outputPath("refresh-error.png"), fullPage: true });
      state.fault = "success"; state.hold = null;
      await button.click();
      await expect(page.getByText("QA Owner", { exact: true })).toBeVisible();
      await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
      expect(state.calls).toBe(2); expect(state.blocked).toEqual([]); expect(errors).toEqual([]);
    });
  }
  test(`${language}: polling failure is visible and next poll recovers without overlapping a slow read`, async ({ page, context }) => {
    const state = await guard(context);
    await page.clock.install();
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(page.getByText("QA Owner", { exact: true })).toBeVisible();
    state.fault = "server_error";
    let release!: () => void;
    state.hold = new Promise<void>(resolve => { release = resolve; });
    try {
      await page.clock.runFor(30_000);
      await expect.poll(() => state.calls).toBe(1);
      await expect(page.getByRole("button", { name: /Refresh|Làm mới/ })).toBeDisabled();
      await page.clock.runFor(30_000);
      expect(state.calls).toBe(1);
    } finally { release(); }
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveText(messages[language]);
    await expect(page.getByText("QA Owner", { exact: true })).toHaveCount(0);
    state.fault = "success"; state.hold = null;
    await page.clock.runFor(30_000);
    await expect(page.getByText("QA Owner", { exact: true })).toBeVisible();
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
    expect(state.calls).toBe(2); expect(state.blocked).toEqual([]);
  });
  test(`${language}: successful empty read remains a real empty state`, async ({ page, context }) => {
    const state = await guard(context);
    await context.addCookies([{ name: "qa-initial", value: "empty", url: origin }]);
    await page.goto("/");
    await expect(page.getByText("No active sessions", { exact: true })).toBeVisible();
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
    expect(state.calls).toBe(0); expect(state.blocked).toEqual([]);
  });
 });
}
