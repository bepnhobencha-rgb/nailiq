import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext } from "@playwright/test";
const fixture = "qa/mfa-status";
const manifest = JSON.parse(readFileSync(`${fixture}/.next/server/server-reference-manifest.json`, "utf8"));
const actions = Object.entries(manifest.node) as [string, { filename: string; exportedName: string }][];
if (actions.some(([, a]) => a.filename !== "actions.ts")) throw new Error("Non-stub action in fixture");
const verifyIds = new Set(actions.filter(([, a]) => a.exportedName === "verifyMfaChallenge").map(([id]) => id));
if (!verifyIds.size) throw new Error("Missing stub verification action");
const origin = "http://127.0.0.1:3123";
const unavailable = "Could not confirm verification. Please try again.";
const alert = '[role="alert"]:not(#__next-route-announcer__)';
async function guard(context: BrowserContext) {
  const state = { calls: 0, fault: "success", hold: null as Promise<void> | null, blocked: [] as string[] };
  await context.route("**/*", async route => {
    const r = route.request();
    if (new URL(r.url()).origin !== origin) { state.blocked.push("external"); return route.abort(); }
    if (["GET", "HEAD"].includes(r.method())) return route.continue();
    if (!verifyIds.has(r.headers()["next-action"])) { state.blocked.push("unexpected action"); return route.abort(); }
    state.calls++;
    if (state.hold) await state.hold;
    if (state.fault === "abort") return route.abort("failed");
    if (state.fault === "503") return route.fulfill({ status: 503, body: "private Auth detail" });
    if (state.fault === "response-loss") { await route.fetch(); return route.abort("failed"); }
    return route.continue();
  });
  return state;
}
for (const fault of ["abort", "503", "response-loss", "throw", "verification_unavailable"]) {
  test(`challenge ${fault}: contains failure and manual retry succeeds`, async ({ page, context }, info) => {
    const state = await guard(context); state.fault = fault;
    if (["throw", "verification_unavailable"].includes(fault))
      await context.addCookies([{ name: "qa-challenge-fault", value: fault, url: origin }]);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto("/challenge");
    const input = page.getByPlaceholder("000000");
    await input.fill("123456"); await input.press("Enter");
    await expect(page.locator(alert)).toHaveText(unavailable);
    await expect(input).toHaveValue("123456");
    await expect(page.getByRole("button", { name: "Verify", exact: true })).toBeEnabled();
    await expect(page.getByTestId("fixture-error")).toHaveCount(0);
    await expect(page.getByText("private Auth detail")).toHaveCount(0);
    await expect(page).toHaveURL(/\/challenge$/);
    expect(state.calls).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    if (fault === "abort") await page.screenshot({ path: info.outputPath("mfa-challenge-error.png"), fullPage: true });
    state.fault = "success"; await context.clearCookies();
    await input.press("Enter");
    await expect(page.getByText("QA verification destination")).toBeVisible();
    expect(state.calls).toBe(2); expect(state.blocked).toEqual([]); expect(errors).toEqual([]);
  });
}
test("challenge pending freezes input and rejects duplicate submissions", async ({ page, context }) => {
  const state = await guard(context);
  let release!: () => void; state.hold = new Promise<void>(r => { release = r; });
  try {
    await page.goto("/challenge");
    const input = page.getByPlaceholder("000000");
    await input.fill("123456"); await input.press("Enter");
    await expect.poll(() => state.calls).toBe(1);
    await expect(input).toBeDisabled();
    await expect(page.getByRole("button", { name: "Verifying…" })).toBeDisabled();
    await page.locator("form").evaluate(f => {
      f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  } finally { release(); }
  await expect(page.getByText("QA verification destination")).toBeVisible();
  expect(state.calls).toBe(1); expect(state.blocked).toEqual([]);
});
test("invalid code can be corrected and verified using the keyboard", async ({ page, context }) => {
  const state = await guard(context);
  await context.addCookies([{ name: "qa-challenge-fault", value: "invalid_code", url: origin }]);
  await page.goto("/challenge");
  const input = page.getByPlaceholder("000000");
  await input.fill("123456"); await input.press("Enter");
  await expect(page.locator(alert)).toHaveText("Invalid code. Try again.");
  await expect(input).toHaveValue("");
  await context.clearCookies(); await input.fill("654321"); await input.press("Enter");
  await expect(page.getByText("QA verification destination")).toBeVisible();
  expect(state.calls).toBe(2); expect(state.blocked).toEqual([]);
});
test("expired session offers a working sign-in link", async ({ page, context }) => {
  const state = await guard(context);
  await context.addCookies([{ name: "qa-challenge-fault", value: "unauthorized", url: origin }]);
  await page.goto("/challenge");
  await page.getByPlaceholder("000000").fill("123456");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(alert)).toContainText("Session expired");
  await page.getByRole("link", { name: "Sign in again" }).click();
  await expect(page.getByText("QA sign-in destination")).toBeVisible();
  expect(state.calls).toBe(1); expect(state.blocked).toEqual([]);
});
test("incomplete input cannot submit even through a form event", async ({ page, context }) => {
  const state = await guard(context);
  await page.goto("/challenge");
  const input = page.getByPlaceholder("000000");
  await input.fill("12a34");
  await expect(input).toHaveValue("1234");
  await expect(page.getByRole("button", { name: "Verify", exact: true })).toBeDisabled();
  await page.locator("form").evaluate(f => f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await expect(input).toHaveValue("1234");
  await expect(page).toHaveURL(/\/challenge$/);
  expect(state.calls).toBe(0); expect(state.blocked).toEqual([]);
});
