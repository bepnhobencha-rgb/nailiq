import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
const fixture = "qa/mfa-status";
const manifest = JSON.parse(readFileSync(`${fixture}/.next/server/server-reference-manifest.json`, "utf8"));
const actions = Object.entries(manifest.node) as [string, { filename: string; exportedName: string }][];
if (actions.some(([, a]) => a.filename !== "actions.ts")) throw new Error("Non-stub action in fixture");
const names = new Map(actions.map(([id, a]) => [id, a.exportedName]));
const buildId = readFileSync(`${fixture}/.next/BUILD_ID`, "utf8").trim();
const origin = "http://127.0.0.1:3123";
const mutations = ["startMfaEnroll", "verifyMfaEnroll", "unenrollMfa"] as const;
const alert = '[role="alert"]:not(#__next-route-announcer__)';
async function guard(context: BrowserContext, target: typeof mutations[number]) {
  const state = { calls: [] as string[], fault: "success", readFailure: false, confirmed: null as boolean | null,
    hold: null as Promise<void> | null, blocked: [] as string[] };
  await context.route("**/*", async route => {
    const r = route.request();
    if (new URL(r.url()).origin !== origin) { state.blocked.push("external"); return route.abort(); }
    if (["GET", "HEAD"].includes(r.method())) return route.continue();
    const name = names.get(r.headers()["next-action"]);
    if (!name || !["getMfaStatus", target, ...(target === "verifyMfaEnroll" ? ["startMfaEnroll"] : [])].includes(name)) {
      state.blocked.push("unexpected action"); return route.abort();
    }
    state.calls.push(name);
    if (name === "getMfaStatus" && (state.readFailure || state.confirmed !== null)) {
      const result = state.readFailure ? { ok: false, error: "load_failed" } :
        { ok: true, enrolled: state.confirmed, factorId: state.confirmed ? "qa-factor" : null };
      return route.fulfill({ status: 200, contentType: "text/x-component", body:
        `0:{"a":"$@1","f":"","q":"","i":false,"b":"${buildId}"}\n1:${JSON.stringify(result)}\n` });
    }
    if (name !== target) return route.continue();
    if (state.hold) await state.hold;
    if (state.fault === "abort") return route.abort("failed");
    if (state.fault === "503") return route.fulfill({ status: 503, body: "private Auth detail" });
    if (state.fault === "response-loss") {
      const response = await route.fetch();
      expect(await response.text()).toContain('"ok":true');
      // Model provider state after the local stub succeeds; only the response is lost.
      state.confirmed = target === "verifyMfaEnroll";
      return route.abort("failed");
    }
    return route.continue();
  });
  return state;
}
async function prepare(page: Page, context: BrowserContext, target: typeof mutations[number]) {
  if (target === "unenrollMfa") await context.addCookies([{ name: "qa-enrolled", value: "yes", url: origin }]);
  await page.goto("/");
  if (target === "verifyMfaEnroll") {
    await page.getByRole("button", { name: "Enable 2FA" }).click();
    await page.getByPlaceholder("000000").fill("123456");
  }
  // Inject read faults only after the initial status is confirmed.
  await expect(button(page, target)).toBeEnabled();
}
function button(page: Page, target: typeof mutations[number]) {
  return page.getByRole("button", { name: target === "startMfaEnroll" ? "Enable 2FA" : target === "verifyMfaEnroll" ? "Confirm" : "Disable 2FA", exact: true });
}
for (const target of mutations) {
  for (const fault of ["abort", "503", "throw", "unavailable"]) {
    test(`${target} ${fault}: recoverable and manual retry only`, async ({ page, context }, info) => {
      const state = await guard(context, target);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await prepare(page, context, target);
      state.fault = fault;
      if (["throw", "unavailable"].includes(fault))
        await context.addCookies([{ name: "qa-enrollment-fault", value: fault, url: origin }]);
      await button(page, target).click();
      await expect(page.locator(alert)).toContainText(/Could not confirm/);
      await expect(button(page, target)).toBeEnabled();
      const targetBox = await button(page, target).boundingBox();
      expect(targetBox?.height).toBeGreaterThanOrEqual(44);
      expect(targetBox?.width).toBeGreaterThanOrEqual(44);
      await expect(page.getByTestId("fixture-error")).toHaveCount(0);
      await expect(page.getByText("private Auth detail")).toHaveCount(0);
      expect(state.calls.filter(x => x === target)).toHaveLength(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (target === "verifyMfaEnroll") await expect(page.getByPlaceholder("000000")).toHaveValue("123456");
      if (fault === "abort") await page.screenshot({ path: info.outputPath(`${target}-recovery.png`), fullPage: true });
      state.fault = "success";
      await context.addCookies([{ name: "qa-enrollment-fault", value: "", url: origin }]);
      await button(page, target).click();
      if (target === "startMfaEnroll") await expect(page.getByAltText("TOTP QR code")).toBeVisible();
      else await expect(page.getByRole("button", { name: target === "verifyMfaEnroll" ? "Disable 2FA" : "Enable 2FA" })).toBeEnabled();
      expect(state.calls.filter(x => x === target)).toHaveLength(2);
      expect(state.blocked).toEqual([]); expect(errors).toEqual([]);
    });
  }
  test(`${target} lost completed response reconciles without replay`, async ({ page, context }) => {
    const state = await guard(context, target);
    await prepare(page, context, target); state.fault = "response-loss";
    await button(page, target).click();
    if (target === "startMfaEnroll") {
      await expect(page.locator(alert)).toContainText("Could not confirm");
      await expect(page.getByAltText("TOTP QR code")).toHaveCount(0);
    } else await expect(page.getByText(target === "verifyMfaEnroll" ? "Two-factor is now ON." : "Two-factor disabled.")).toBeVisible();
    await expect(page.getByRole("button", { name: target === "verifyMfaEnroll" ? "Disable 2FA" : "Enable 2FA" })).toBeEnabled();
    expect(state.calls.filter(x => x === target)).toHaveLength(1);
    expect(state.blocked).toEqual([]);
  });
  test(`${target} failed reconciliation stays unknown until read retry`, async ({ page, context }) => {
    const state = await guard(context, target);
    await prepare(page, context, target); state.fault = "abort"; state.readFailure = true;
    await button(page, target).click();
    await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect(page.getByAltText("TOTP QR code")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Enable 2FA|Disable 2FA|Confirm/ })).toHaveCount(0);
    state.readFailure = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("button", { name: target === "unenrollMfa" ? "Disable 2FA" : "Enable 2FA" })).toBeEnabled();
    expect(state.calls.filter(x => x === target)).toHaveLength(1); expect(state.blocked).toEqual([]);
  });
}
test("confirmation pending freezes code and cancel; keyboard submits once", async ({ page, context }) => {
  const state = await guard(context, "verifyMfaEnroll"); await prepare(page, context, "verifyMfaEnroll");
  let release!: () => void; state.hold = new Promise<void>(r => { release = r; });
  try {
    await page.getByPlaceholder("000000").press("Enter");
    await expect.poll(() => state.calls.filter(x => x === "verifyMfaEnroll").length).toBe(1);
    await expect(page.getByPlaceholder("000000")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.locator("form").evaluate(f => {
      f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  } finally { release(); }
  await expect(page.getByRole("button", { name: "Disable 2FA" })).toBeEnabled();
  expect(state.calls.filter(x => x === "verifyMfaEnroll")).toHaveLength(1); expect(state.blocked).toEqual([]);
});
test("invalid code clears for correction; unavailable preserves code", async ({ page, context }) => {
  const state = await guard(context, "verifyMfaEnroll"); await prepare(page, context, "verifyMfaEnroll");
  await context.addCookies([{ name: "qa-enrollment-fault", value: "invalid_code", url: origin }]);
  await button(page, "verifyMfaEnroll").click();
  await expect(page.locator(alert)).toHaveText("Invalid code. Try again.");
  await expect(page.getByPlaceholder("000000")).toHaveValue("");
  await context.addCookies([{ name: "qa-enrollment-fault", value: "", url: origin }]);
  await page.getByPlaceholder("000000").fill("654321"); await page.getByPlaceholder("000000").press("Enter");
  await expect(page.getByRole("button", { name: "Disable 2FA" })).toBeEnabled();
  expect(state.calls.filter(x => x === "verifyMfaEnroll")).toHaveLength(2); expect(state.blocked).toEqual([]);
});
for (const target of mutations) test(`${target} expired session clears secrets and offers sign-in`, async ({ page, context }) => {
  const state = await guard(context, target); await prepare(page, context, target);
  await context.addCookies([{ name: "qa-enrollment-fault", value: "unauthorized", url: origin }]);
  await button(page, target).click();
  await expect(page.locator(alert)).toHaveText("Session expired — sign in again.");
  await expect(page.getByAltText("TOTP QR code")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Enable 2FA|Disable 2FA|Confirm/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Sign in again" }).click();
  await expect(page.getByText("QA sign-in destination")).toBeVisible();
  expect(state.calls.filter(x => x === target)).toHaveLength(1); expect(state.blocked).toEqual([]);
});
for (const target of ["startMfaEnroll", "unenrollMfa"] as const) test(`${target} pending rejects repeated clicks`, async ({ page, context }) => {
  const state = await guard(context, target); await prepare(page, context, target);
  let release!: () => void; state.hold = new Promise<void>(r => { release = r; });
  try {
    await button(page, target).click();
    await expect.poll(() => state.calls.filter(x => x === target).length).toBe(1);
    await expect(button(page, target)).toBeDisabled();
    await button(page, target).evaluate(b => {
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  } finally { release(); }
  if (target === "startMfaEnroll") await expect(page.getByAltText("TOTP QR code")).toBeVisible();
  else await expect(page.getByRole("button", { name: "Enable 2FA" })).toBeEnabled();
  expect(state.calls.filter(x => x === target)).toHaveLength(1); expect(state.blocked).toEqual([]);
});
for (const target of ["verifyMfaEnroll", "unenrollMfa"] as const) test(`${target} success with failed status read does not display unconfirmed success`, async ({ page, context }) => {
  const state = await guard(context, target); await prepare(page, context, target); state.readFailure = true;
  await button(page, target).click();
  await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/Two-factor is now ON\.|Two-factor disabled\./)).toHaveCount(0);
  await expect(page.getByAltText("TOTP QR code")).toHaveCount(0);
  state.readFailure = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: target === "verifyMfaEnroll" ? "Disable 2FA" : "Enable 2FA" })).toBeEnabled();
  expect(state.calls.filter(x => x === target)).toHaveLength(1); expect(state.blocked).toEqual([]);
});
test("incomplete enrollment code cannot submit through a form event", async ({ page, context }) => {
  const state = await guard(context, "verifyMfaEnroll"); await prepare(page, context, "verifyMfaEnroll");
  const input = page.getByLabel("2. Enter the 6-digit code:");
  await input.fill("12x34"); await expect(input).toHaveValue("1234");
  await expect(button(page, "verifyMfaEnroll")).toBeDisabled();
  await page.locator("form").evaluate(f => f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await expect(input).toHaveValue("1234");
  expect(state.calls.filter(x => x === "verifyMfaEnroll")).toHaveLength(0); expect(state.blocked).toEqual([]);
});
test("cancel after a failed confirmation clears code, secret and error", async ({ page, context }) => {
  const state = await guard(context, "verifyMfaEnroll"); await prepare(page, context, "verifyMfaEnroll"); state.fault = "abort";
  await button(page, "verifyMfaEnroll").click(); await expect(page.locator(alert)).toContainText("Could not confirm");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Enable 2FA" })).toBeEnabled();
  await expect(page.getByAltText("TOTP QR code")).toHaveCount(0); await expect(page.locator(alert)).toHaveCount(0);
  expect(state.calls.filter(x => x === "verifyMfaEnroll")).toHaveLength(1); expect(state.blocked).toEqual([]);
});
