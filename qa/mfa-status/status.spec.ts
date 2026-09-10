import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext } from "@playwright/test";
const fixture = "qa/mfa-status";
const manifest = JSON.parse(readFileSync(`${fixture}/.next/server/server-reference-manifest.json`, "utf8"));
const exported = Object.values(manifest.node) as { filename: string; exportedName: string }[];
const allowed = ["getMfaStatus", "startMfaEnroll", "verifyMfaEnroll", "unenrollMfa", "verifyMfaChallenge"];
if (exported.some(a => a.filename !== "actions.ts" || !allowed.includes(a.exportedName)) || !exported.some(a => a.exportedName === "getMfaStatus")) throw new Error("Fixture contains unexpected actions");
const readIds = new Set(Object.entries(manifest.node).filter(([, a]) => (a as { exportedName: string }).exportedName === "getMfaStatus").map(([id]) => id));
const buildId = readFileSync(`${fixture}/.next/BUILD_ID`, "utf8").trim();
const origin = "http://127.0.0.1:3123";
async function guard(context: BrowserContext) {
  const state = { calls: 0, fault: "success", hold: null as Promise<void> | null, blocked: [] as string[] };
  await context.route("**/*", async route => {
    const r = route.request();
    if (new URL(r.url()).origin !== origin) { state.blocked.push("external"); return route.abort(); }
    if (["GET", "HEAD"].includes(r.method())) return route.continue();
    if (!readIds.has(r.headers()["next-action"])) { state.blocked.push("mutation"); return route.abort(); }
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
const alert = '[role="alert"]:not(#__next-route-announcer__)';
for (const enrolled of [false, true]) {
  test(`slow status read offers no MFA mutation until confirmed ${enrolled ? "ON" : "OFF"}`, async ({ page, context }) => {
    const state = await guard(context);
    if (enrolled) await context.addCookies([{ name: "qa-enrolled", value: "yes", url: origin }]);
    let release!: () => void;
    state.hold = new Promise<void>(resolve => { release = resolve; });
    try {
      await page.goto("/");
      await expect.poll(() => state.calls).toBe(1);
      await expect(page.getByRole("button", { name: /Enable 2FA|Disable 2FA/ })).toHaveCount(0);
      await expect(page.getByText(/^(ON|OFF)$/)).toHaveCount(0);
    } finally { release(); }
    await expect(page.getByText(enrolled ? "ON" : "OFF", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: enrolled ? "Disable 2FA" : "Enable 2FA", exact: true })).toBeEnabled();
    expect(state.calls).toBe(1); expect(state.blocked).toEqual([]);
  });
}
for (const fault of ["abort", "503", "load_failed", "unauthorized"]) {
  test(`${fault}: unknown status stays safe and keyboard retry reads once`, async ({ page, context }, info) => {
    const state = await guard(context); state.fault = fault;
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto("/");
    await expect(page.locator(alert)).toHaveText(fault === "unauthorized"
      ? "Session expired — sign in again."
      : "Could not load two-factor status. Please try again.");
    await expect(page.getByText(/^(ON|OFF)$/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Enable 2FA|Disable 2FA/ })).toHaveCount(0);
    await expect(page.getByTestId("fixture-error")).toHaveCount(0);
    await expect(page.getByText("private backend detail")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    if (fault === "abort") await page.screenshot({ path: info.outputPath("mfa-status-error.png"), fullPage: true });
    state.fault = "success";
    await context.addCookies([{ name: "qa-enrolled", value: "yes", url: origin }]);
    let release!: () => void;
    state.hold = new Promise<void>(resolve => { release = resolve; });
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    try {
      await retry.focus(); await retry.press("Enter");
      await expect.poll(() => state.calls).toBe(2);
      await expect(page.getByRole("button", { name: /Checking|Try again/ })).toBeDisabled();
      await page.keyboard.press("Enter");
      expect(state.calls).toBe(2);
    } finally { release(); }
    await expect(page.getByText("ON", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Disable 2FA", exact: true })).toBeEnabled();
    await expect(page.locator(alert)).toHaveCount(0);
    expect(state.calls).toBe(2); expect(state.blocked).toEqual([]); expect(errors).toEqual([]);
  });
}
