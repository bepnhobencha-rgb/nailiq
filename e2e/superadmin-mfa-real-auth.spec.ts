import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { expect, request, type BrowserContext, type Page } from "@playwright/test";
import { test, localAuthHttpsOrigin } from "./helpers/localAuthHttps";
import { withLocalAuthCleanup } from "./helpers/localAuthCleanup";
import { localTotp } from "./helpers/localTotp";
import { seedTestSuperadmin, type SeededSuperAdmin } from "./helpers/superadmin";

// Never allow this real factor lifecycle against a hosted Auth project.
const authUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid");
if (authUrl.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(authUrl.hostname)) {
  throw new Error("MFA acceptance requires disposable loopback Supabase Auth");
}
if (process.env.NEXT_PUBLIC_DEMO_OTP !== "false" || process.env.DEMO_OTP !== "false") {
  throw new Error("MFA acceptance requires demo Auth disabled");
}
const admin = createClient(authUrl.origin, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8"));
const names = new Map<string, string>(Object.entries(manifest.node).map(([id, value]) =>
  [id, (value as { exportedName: string }).exportedName]));
const allowed = ["loginSuperadmin", "logoutSuperadmin", "getMfaStatus", "startMfaEnroll", "verifyMfaEnroll", "verifyMfaChallenge", "unenrollMfa"];
const alert = '[role="alert"]:not(#__next-route-announcer__)';

// Passwords, QR secrets and cookies must not enter traces, videos or auto captures.
test.use({ baseURL: localAuthHttpsOrigin, ignoreHTTPSErrors: true, trace: "off", video: "off", screenshot: "off" });

test.afterEach(async ({ context }, info) => {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    if (info.status !== info.expectedStatus) {
      await info.attach("mfa-failure-redacted", {
        body: await page.screenshot({ mask: [page.locator("code"), page.locator("input"), page.getByAltText("TOTP QR code")] }),
        contentType: "image/png",
      });
    }
    // Keep automatic error-context snapshots free of QA secrets as well.
    await page.goto("about:blank");
  }
});

async function guard(context: BrowserContext) {
  const groups = randomBytes(8).toString("hex").match(/.{4}/g)!;
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `2001:db8:${groups.join(":")}:1:1` });
  const state = { calls: [] as string[], blocked: [] as string[], lose: "", pageErrors: [] as string[], excluded: [] as string[] };
  const observe = (page: Page) => page.on("pageerror", e => state.pageErrors.push(
    new URL(page.url()).pathname + ": " + (e.name + ":" + e.message).replace(/(https?:\/\/[^?\s]+)[^\s]*/g, "$1"),
  ));
  for (const page of context.pages()) observe(page);
  context.on("page", observe);
  await context.route("**/*", async route => {
    const r = route.request();
    if (new URL(r.url()).origin !== localAuthHttpsOrigin) {
      state.excluded.push(new URL(r.url()).origin + new URL(r.url()).pathname);
      // Fonts/images may be external; none are needed by this acceptance.
      return route.abort("blockedbyclient");
    }
    if (["GET", "HEAD"].includes(r.method())) return route.continue();
    const name = names.get(r.headers()["next-action"]);
    if (!name || !allowed.includes(name)) {
      state.blocked.push(name ?? new URL(r.url()).pathname);
      return route.abort("blockedbyclient");
    }
    state.calls.push(name);
    if (state.lose !== name) return route.continue();
    state.lose = "";
    // Isolated cookie jar: even Set-Cookie from the completed action is lost.
    // No response body, cookie or provider state is replaced with a stub.
    const transport = await request.newContext({ ignoreHTTPSErrors: true, storageState: await context.storageState() });
    try {
      const result = await transport.fetch(r.url(), {
        method: r.method(), headers: await r.allHeaders(), data: r.postDataBuffer()!, maxRedirects: 0,
      });
      expect(result.status()).toBe(200);
      expect((await result.text()).includes('"ok":true'), "Real action must finish before response is discarded").toBe(true);
    } finally { await transport.dispose(); }
    return route.abort("failed");
  });
  return state;
}

async function factors(account: SeededSuperAdmin) {
  const result = await admin.auth.admin.mfa.listFactors({ userId: account.userId });
  expect(result.error).toBeNull();
  return result.data!.factors.filter(f => f.factor_type === "totp");
}
async function expectFactors(account: SeededSuperAdmin, statuses: string[]) {
  await expect.poll(async () => (await factors(account)).map(f => f.status).sort()).toEqual(statuses);
}
async function cleanup(account: SeededSuperAdmin) {
  expect(account.email.startsWith("e2e-superadmin-") && account.email.endsWith("@nailiq.test.invalid")).toBe(true);
  await withLocalAuthCleanup(
    async () => { expect((await admin.from("superadmin_audit_logs").delete().eq("actor_user_id", account.userId)).error).toBeNull(); },
    async () => { expect((await admin.from("superadmins").delete().eq("user_id", account.userId)).error).toBeNull(); },
    async () => {
      expect((await admin.auth.admin.deleteUser(account.userId)).error).toBeNull();
      const remaining = await admin.auth.admin.getUserById(account.userId);
      expect(remaining.data.user).toBeNull();
      expect(remaining.error?.status).toBe(404);
    },
  );
}
async function signIn(page: Page, account: SeededSuperAdmin, challenge = false) {
  await page.goto("/superadmin/login");
  const form = page.getByTestId("superadmin-login-form");
  await form.locator('input[type="email"]').fill(account.email);
  await form.locator('input[type="password"]').fill(account.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(challenge ? /\/superadmin\/mfa$/ : /\/superadmin\/dashboard$/);
}
async function assurance(context: BrowserContext, account: SeededSuperAdmin) {
  const cookies = (await context.cookies()).filter(c => /^sb-.+-auth-token(?:\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  expect(cookies.length > 0).toBe(true);
  await test.info().attach("session-cookie-attributes", { body: JSON.stringify(cookies.map(({ name, secure, httpOnly, sameSite }) => ({ name, secure, httpOnly, sameSite }))), contentType: "application/json" });
  const packed = cookies.map(c => c.value).join("");
  const session = JSON.parse(Buffer.from(packed.slice("base64-".length), "base64url").toString());
  const user = await admin.auth.getUser(session.access_token);
  expect(user.error).toBeNull(); expect(user.data.user?.id).toBe(account.userId);
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString());
  return claims.aal as string;
}
async function securityPage(context: BrowserContext) {
  // Keep the sign-in document alive while its dashboard prefetches settle.
  // This matches the existing SuperAdmin role-boundary QA helper: rapid goto
  // on that document cancels reads and creates WebKit-only transport noise.
  const page = await context.newPage();
  await page.goto("/superadmin/security", { waitUntil: "networkidle" });
  return page;
}
async function begin(page: Page) {
  await page.getByRole("button", { name: "Enable 2FA", exact: true }).click();
  const qr = page.getByAltText("TOTP QR code");
  await expect(qr).toBeVisible();
  await expect.poll(() => qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await test.info().attach("mfa-enrollment-redacted", {
    body: await page.screenshot({ mask: [page.locator("code"), page.locator("input"), qr] }),
    contentType: "image/png",
  });
  const secret = await page.locator("main code").textContent();
  expect(Boolean(secret && /^[A-Z2-7]+$/.test(secret))).toBe(true);
  return secret!;
}
function invalidCode(secret: string) {
  const now = Date.now();
  const valid = new Set([-1, 0, 1, 2].map(step => localTotp(secret, now + step * 30_000)));
  // Guarantee a different code even if a stale code happens to collide modulo 1e6.
  for (let i = 0; i < 1_000_000; i++) {
    const code = i.toString().padStart(6, "0");
    if (!valid.has(code)) return code;
  }
  throw new Error("No invalid QA code available");
}
async function freshCode(secret: string, previous?: string) {
  await expect.poll(() => Date.now() % 30_000 < 26_000 && localTotp(secret) !== previous,
    { timeout: 36_000, intervals: [200, 500, 1000] }).toBe(true);
  return localTotp(secret);
}
async function confirm(page: Page, secret: string) {
  const code = await freshCode(secret);
  await page.getByLabel("2. Enter the 6-digit code:").fill(code);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Two-factor is now ON.", { exact: true })).toBeVisible();
  await expect(page.getByAltText("TOTP QR code")).toHaveCount(0);
  return code;
}
async function finish(page: Page, state: Awaited<ReturnType<typeof guard>>) {
  await test.info().attach("traffic-diagnostics", { body: JSON.stringify({ excluded: state.excluded, pageErrors: state.pageErrors }), contentType: "application/json" });
  expect(state.blocked).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}

for (const role of ["founder", "ops_admin"] as const) {
  test(`${role}: real TOTP enrollment, invalid codes, login AAL2 and disable persist`, async ({ page, context }) => {
    const account = await seedTestSuperadmin({ role });
    await withLocalAuthCleanup(async () => {
      const state = await guard(context);
      await signIn(page, account);
      expect(await assurance(context, account)).toBe("aal1");
      page = await securityPage(context);
      const secret = await begin(page);
      await expectFactors(account, ["unverified"]);
      // A code outside the current acceptance window must not enroll the factor.
      await page.getByLabel("2. Enter the 6-digit code:").fill(invalidCode(secret));
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect(page.locator(alert)).toHaveText("Invalid code. Try again.");
      await expectFactors(account, ["unverified"]);
      const used = await confirm(page, secret);
      await expectFactors(account, ["verified"]);
      expect(await assurance(context, account)).toBe("aal2");
      page = await securityPage(context);
      await expect(page.getByRole("button", { name: "Disable 2FA" })).toBeEnabled();
      // A new browser session must encounter the actual shell gate.
      await context.clearCookies();
      page = await context.newPage();
      await signIn(page, account, true);
      expect(await assurance(context, account)).toBe("aal1");
      await page.getByLabel("Authenticator code").fill(invalidCode(secret));
      await page.getByRole("button", { name: "Verify", exact: true }).click();
      await expect(page.locator(alert)).toHaveText("Invalid code. Try again.");
      await expect(page).toHaveURL(/\/superadmin\/mfa$/);
      expect(await assurance(context, account)).toBe("aal1");
      await page.getByLabel("Authenticator code").fill(await freshCode(secret, used));
      await page.getByLabel("Authenticator code").press("Enter");
      await expect(page).toHaveURL(/\/superadmin\/dashboard$/);
      expect(await assurance(context, account)).toBe("aal2");
      page = await securityPage(context);
      await page.getByRole("button", { name: "Disable 2FA" }).click();
      await expect(page.getByText("Two-factor disabled.", { exact: true })).toBeVisible();
      await expectFactors(account, []);
      await context.clearCookies();
      page = await context.newPage();
      await signIn(page, account);
      expect(await assurance(context, account)).toBe("aal1");
      page = await securityPage(context);
      await expect(page.getByRole("button", { name: "Enable 2FA" })).toBeEnabled();
      await finish(page, state);
      await test.info().attach("mfa-disabled", { body: await page.screenshot(), contentType: "image/png" });
    }, () => cleanup(account));
  });
}

for (const role of ["support_admin", "billing_admin", "ai_admin", "readonly_analyst"] as const) {
  test(`${role}: security page stays outside the existing role boundary`, async ({ page, context }) => {
    const account = await seedTestSuperadmin({ role });
    await withLocalAuthCleanup(async () => {
      const state = await guard(context);
      await signIn(page, account);
      page = await context.newPage();
      const response = await page.goto("/superadmin/security", { waitUntil: "networkidle" });
      expect(response?.status()).toBeLessThan(500);
      await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Two-factor authentication (TOTP)" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Enable 2FA|Disable 2FA/ })).toHaveCount(0);
      await expectFactors(account, []);
      await finish(page, state);
    }, () => cleanup(account));
  });
}

test("cancel then restart removes the old unverified factor", async ({ page, context }) => {
  const account = await seedTestSuperadmin({ role: "founder" });
  await withLocalAuthCleanup(async () => {
    const state = await guard(context); await signIn(page, account);
    page = await securityPage(context);
    await begin(page); const old = (await factors(account))[0].id;
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByAltText("TOTP QR code")).toHaveCount(0);
    const secret = await begin(page);
    await expectFactors(account, ["unverified"]);
    expect((await factors(account))[0].id === old).toBe(false);
    await confirm(page, secret); await expectFactors(account, ["verified"]);
    await finish(page, state);
  }, () => cleanup(account));
});

for (const operation of ["startMfaEnroll", "verifyMfaEnroll", "unenrollMfa"] as const) {
  test(`${operation}: completed real Auth response is lost without mutation replay`, async ({ page, context }) => {
    const account = await seedTestSuperadmin({ role: "founder" });
    await withLocalAuthCleanup(async () => {
      const state = await guard(context); await signIn(page, account);
      page = await securityPage(context);
      await expect(page.getByRole("button", { name: "Enable 2FA" })).toBeEnabled();
      let secret = "", used = "";
      if (operation !== "startMfaEnroll") {
        secret = await begin(page);
        if (operation === "unenrollMfa") await confirm(page, secret);
        else {
          used = await freshCode(secret);
          await page.getByLabel("2. Enter the 6-digit code:").fill(used);
        }
      }
      state.lose = operation;
      await page.getByRole("button", { name: operation === "startMfaEnroll" ? "Enable 2FA" : operation === "verifyMfaEnroll" ? "Confirm" : "Disable 2FA", exact: true }).click();
      if (operation === "startMfaEnroll") {
        await expect(page.locator(alert)).toHaveText("Could not confirm enrollment. Please try again.");
        await expect(page.getByAltText("TOTP QR code")).toHaveCount(0);
        await expectFactors(account, ["unverified"]);
      } else {
        await expect(page.getByText(operation === "verifyMfaEnroll" ? "Two-factor is now ON." : "Two-factor disabled.", { exact: true })).toBeVisible();
        await expectFactors(account, operation === "verifyMfaEnroll" ? ["verified"] : []);
      }
      expect(state.calls.filter(name => name === operation)).toHaveLength(1);
      if (operation === "startMfaEnroll") {
        const old = (await factors(account))[0].id;
        await begin(page); // Explicit user retry; the lost secret must be replaced.
        await expectFactors(account, ["unverified"]);
        expect((await factors(account))[0].id === old).toBe(false);
        expect(state.calls.filter(name => name === operation)).toHaveLength(2);
      }
      if (operation === "verifyMfaEnroll") {
        // Prove the cookie response was truly lost, then complete manual step-up.
        expect(await assurance(context, account)).toBe("aal1");
        await context.clearCookies();
      page = await context.newPage();
        await signIn(page, account, true);
        await page.getByLabel("Authenticator code").fill(await freshCode(secret, used));
        await page.getByRole("button", { name: "Verify", exact: true }).click();
        await expect(page).toHaveURL(/\/superadmin\/dashboard$/);
        expect(await assurance(context, account)).toBe("aal2");
        expect(state.calls.filter(name => name === operation)).toHaveLength(1);
      }
      await finish(page, state);
    }, () => cleanup(account));
  });
}
