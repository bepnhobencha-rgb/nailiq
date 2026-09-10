import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext } from "@playwright/test";

const fixture = "qa/signout-response";
const manifest = JSON.parse(readFileSync(`${fixture}/.next/server/server-reference-manifest.json`, "utf8"));
const actions = Object.values(manifest.node) as { filename: string; exportedName: string }[];
if (JSON.stringify(actions.map(a => `${a.filename}:${a.exportedName}`).sort()) !== JSON.stringify([
  "action.ts:signOutAction", "superadmin-action.ts:signOutSuperadminAction",
])) throw new Error("Refusing to run: fixture must contain only its two inert sign-out actions");
const actionIds = new Set(Object.keys(manifest.node));
const buildId = readFileSync(`${fixture}/.next/BUILD_ID`, "utf8").trim();
const origin = "http://127.0.0.1:3120";
const messages = {
  en: "We couldn’t confirm sign-out. Please try again.",
  vi: "Chưa xác nhận được việc đăng xuất. Vui lòng thử lại.",
};
type Fault = "429" | "503" | "abort" | "server_error";
async function guard(context: BrowserContext, fault: Fault) {
  const state = { calls: 0, success: false, hold: null as Promise<void> | null, blocked: [] as string[] };
  await context.route("**/*", async route => {
    const r = route.request();
    if (new URL(r.url()).origin !== origin) {
      state.blocked.push(r.url());
      return route.abort("blockedbyclient");
    }
    if (["GET", "HEAD"].includes(r.method())) return route.continue();
    if (!actionIds.has(r.headers()["next-action"])) {
      state.blocked.push(`${r.method()} ${r.url()}`);
      return route.abort("blockedbyclient");
    }
    state.calls++;
    if (state.hold) await state.hold;
    // Let the real Next action execute redirect(); never fake a success result.
    if (state.success) return route.continue();
    if (fault === "abort") return route.abort("failed");
    if (fault === "429" || fault === "503") return route.fulfill({ status: Number(fault), contentType: "text/plain", body: "QA private transport detail" });
    return route.fulfill({ contentType: "text/x-component", body:
      `0:${JSON.stringify({ a: "$@1", f: "", q: "", i: false, b: buildId })}\n1:${JSON.stringify({ ok: false, error: "server_error" })}\n` });
  });
  return state;
}
for (const language of ["en", "vi"] as const) {
  for (const surface of ["choose", "dashboard", "superadmin", "compact"] as const) {
    const label = language === "vi" && (surface === "choose" || surface === "dashboard") ? "Đăng xuất" : "Sign out";
    const destination = surface === "superadmin" || surface === "compact" ? "/superadmin/login" : "/login";
    for (const fault of ["429", "503", "abort", "server_error"] as const) {
      test(`${language} ${surface} ${fault}: recover with an explicit retry and a real redirect`, async ({ page, context }, info) => {
        const state = await guard(context, fault);
        const errors: string[] = [];
        page.on("pageerror", e => errors.push(e.message));
        page.on("dialog", dialog => dialog.accept());
        await page.addInitScript(lang => localStorage.setItem("nailiq-user-lang", lang), language);
        await page.goto(`/?surface=${surface}`);
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        const button = page.getByRole("button", { name: label, exact: true });
        let release!: () => void;
        state.hold = new Promise<void>(resolve => { release = resolve; });
        try {
          await button.click();
          await expect(button).toBeDisabled();
          await expect(button).toHaveAttribute("aria-busy", "true");
          if (surface === "choose") await expect(page.getByRole("button", { name: language === "en" ? "Try again" : "Thử lại", exact: true })).toBeDisabled();
          await expect.poll(() => state.calls).toBe(1);
        } finally { release(); }
        const feedback = page.getByRole("status");
        await expect(feedback).toHaveText(messages[language]);
        await expect(feedback.locator("div")).toHaveCSS("opacity", "1");
        await expect(button).toBeEnabled();
        await expect(page.getByTestId("fixture-error-boundary")).toHaveCount(0);
        await expect(page.getByText("QA private transport detail")).toHaveCount(0);
        expect(new URL(page.url()).pathname).toBe("/");
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        const box = (await feedback.locator("div").boundingBox())!;
        const viewport = page.viewportSize()!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
        if (fault === "abort") await page.screenshot({ path: info.outputPath("unconfirmed.png"), fullPage: true });
        expect(state.calls).toBe(1);
        state.success = true;
        state.hold = null;
        await button.click();
        await expect(page).toHaveURL(origin + destination);
        await expect(page.getByRole("heading")).toHaveText("QA signed out destination");
        await expect(page.getByRole("status")).toHaveCount(0);
        expect(state.calls).toBe(2);
        expect(state.blocked).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
    if (surface !== "choose") test(`${language} ${surface}: cancel confirmation sends no action`, async ({ page, context }) => {
      const state = await guard(context, "503");
      await page.addInitScript(lang => localStorage.setItem("nailiq-user-lang", lang), language);
      page.on("dialog", dialog => dialog.dismiss());
      await page.goto(`/?surface=${surface}`);
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await page.getByRole("button", { name: label, exact: true }).click();
      expect(state.calls).toBe(0);
      await expect(page.getByRole("status")).toHaveCount(0);
    });
  }
}
