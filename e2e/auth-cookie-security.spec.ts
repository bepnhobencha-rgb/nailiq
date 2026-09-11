import { randomBytes } from "node:crypto";
import { createChunks } from "@supabase/ssr";
import { expect, type BrowserContext } from "@playwright/test";
import { test, localAuthHttpsOrigin } from "./helpers/localAuthHttps";
import { withLocalAuthCleanup } from "./helpers/localAuthCleanup";
import { cleanupTestSalon, cleanupTestUser, seedTestSalon, seedTestSalonMember } from "./helpers/db";

const authUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid");
const appOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? "";
const secure = appOrigin === localAuthHttpsOrigin;
if (authUrl.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(authUrl.hostname) ||
    ![localAuthHttpsOrigin, "http://localhost:3000"].includes(appOrigin) ||
    process.env.DEMO_OTP !== "false" || process.env.NEXT_PUBLIC_DEMO_OTP !== "false") {
  throw new Error("Cookie acceptance requires disposable loopback Auth/app and demo disabled");
}
test.use({ baseURL: appOrigin, ignoreHTTPSErrors: true, trace: "off", video: "off", screenshot: "off" });
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) if (!page.isClosed()) await page.goto("about:blank");
});

async function sessionCookies(context: BrowserContext) {
  return (await context.cookies()).filter(cookie => /^sb-.+-auth-token(?:\.\d+)?$/.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
async function assertSecure(context: BrowserContext) {
  const cookies = await sessionCookies(context);
  expect(cookies.length).toBeGreaterThan(0);
  expect(cookies.every(cookie => cookie.secure === secure && cookie.sameSite === "Lax" && cookie.path === "/")).toBe(true);
  await test.info().attach("session-cookie-attributes", {
    body: JSON.stringify(cookies.map(({ name, secure, sameSite, httpOnly }) => ({ name, secure, sameSite, httpOnly }))),
    contentType: "application/json",
  });
  return cookies;
}

for (const role of ["owner", "admin", "senior", "receptionist", "nail_tech"] as const) {
  test(`${role}: password login and real proxy refresh preserve the cookie transport policy`, async ({ page, context }) => {
    const salon = await seedTestSalon();
    let user: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
    await withLocalAuthCleanup(async () => {
      user = await seedTestSalonMember(salon.salonId, role);
      const groups = randomBytes(8).toString("hex").match(/.{4}/g)!;
      await context.setExtraHTTPHeaders({ "x-forwarded-for": `2001:db8:${groups.join(":")}:1:1` });
      await context.route("**/*", route => {
        const host = new URL(route.request().url()).hostname;
        return ["localhost", "127.0.0.1"].includes(host) ? route.continue() : route.abort("blockedbyclient");
      });
      await page.addInitScript(() => localStorage.setItem("nailiq-user-lang", "en"));
      await page.goto("/login");
      await expect(page.getByTestId("password-signin-submit")).toBeEnabled();
      await page.locator('input[inputmode="email"]').fill(user.email);
      await page.locator('input[type="password"]').fill(user.password);
      await page.getByTestId("password-signin-submit").click();
      const destination = `/dashboard/${salon.slug}` + (["owner", "admin"].includes(role) ? "" : "/center");
      await expect.poll(() => new URL(page.url()).pathname).toBe(destination);
      const original = await assertSecure(context);
      // Stop browser refresh/prefetch before expiring only the local SDK expiry
      // metadata. The signed access token and real refresh token stay intact.
      await page.goto("about:blank");
      const packed = original.map(cookie => cookie.value).join("");
      const session = JSON.parse(Buffer.from(packed.slice("base64-".length), "base64url").toString());
      session.expires_at = 1;
      const expired = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
      for (const cookie of original) await context.clearCookies({ name: cookie.name });
      const key = original[0].name.replace(/\.\d+$/, "");
      await context.addCookies(createChunks(key, expired).map(chunk => ({ ...original[0], ...chunk })));
      // The request goes through real Next proxy + GoTrue. No provider result
      // is mocked. Inspect the raw response before any client script runs.
      const refreshed = await context.request.get(appOrigin + destination);
      expect(refreshed.status()).toBe(200);
      const writes = refreshed.headersArray().filter(header => header.name.toLowerCase() === "set-cookie" && header.value.startsWith("sb-"));
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every(header => /;\s*secure(?:;|$)/i.test(header.value) === secure)).toBe(true);
      const renewed = await assertSecure(context);
      const nextSession = JSON.parse(Buffer.from(renewed.map(cookie => cookie.value).join("").slice("base64-".length), "base64url").toString());
      expect(nextSession.expires_at > Date.now() / 1000).toBe(true);
      await page.goto(destination);
      await expect.poll(() => new URL(page.url()).pathname).toBe(destination);
      await expect(page.locator("main")).toBeVisible();
      expect((await context.cookies()).some(cookie => cookie.name === "nailiq-demo-slug")).toBe(false);
    }, () => cleanupTestSalon(salon.slug), async () => { if (user) await cleanupTestUser(user.userId); });
  });
}

for (const language of ["en", "vi"] as const) {
  test(`${language}: browser SDK sets the PKCE cookie before Google handoff`, async ({ page, context }) => {
    let handoffs = 0;
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === authUrl.origin && url.pathname === "/auth/v1/authorize") {
        handoffs++;
        return route.fulfill({ status: 200, contentType: "text/html", body: '<main data-testid="handoff">Intercepted locally</main>' });
      }
      if (url.origin !== appOrigin || !["GET", "HEAD"].includes(route.request().method())) return route.abort("blockedbyclient");
      return route.continue();
    });
    await page.addInitScript(lang => localStorage.setItem("nailiq-user-lang", lang), language);
    await page.goto("/login");
    await page.getByRole("button", { name: language === "en" ? "Continue with Google" : "Tiếp tục với Google", exact: true }).click();
    await expect(page.getByTestId("handoff")).toBeVisible();
    expect(handoffs).toBe(1);
    const cookies = (await context.cookies()).filter(cookie => cookie.name.includes("-code-verifier"));
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies.every(cookie => cookie.secure === secure)).toBe(true);
  });
}

// This loopback HTTPS bridge requires Playwright to intercept the Auth request.
// Once the PWA worker controls the page, WebKit can bypass that route and try
// TLS against the HTTP-only GoTrue listener. Isolate this transport test from
// service workers so refresh still reaches real local Auth through the bridge.
const routedRefreshTest = test.extend({ serviceWorkers: "block" });

routedRefreshTest("automatic browser refresh preserves cookie flags after returning to the front desk", async ({ page, context }) => {
  const salon = await seedTestSalon();
  let user: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
  await withLocalAuthCleanup(async () => {
    user = await seedTestSalonMember(salon.salonId, "receptionist");
    const groups = randomBytes(8).toString("hex").match(/.{4}/g)!;
    await context.setExtraHTTPHeaders({ "x-forwarded-for": `2001:db8:${groups.join(":")}:1:1` });
    let localRefreshes = 0;
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.host === authUrl.host && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
        // WebKit upgrades the loopback HTTP Auth URL under the app's HTTPS
        // CSP, but the disposable GoTrue listener has no TLS. Bridge only
        // this local transport; preserve the real request/body/Auth response.
        const response = await route.fetch({ url: authUrl.origin + url.pathname + url.search, maxRedirects: 0 });
        localRefreshes++;
        return route.fulfill({ response });
      }
      return ["localhost", "127.0.0.1"].includes(url.hostname)
        ? route.continue() : route.abort("blockedbyclient");
    });
    await page.goto("/login");
    await expect(page.getByTestId("password-signin-submit")).toBeEnabled();
    await page.locator('input[inputmode="email"]').fill(user.email);
    await page.locator('input[type="password"]').fill(user.password);
    await test.step("Submit password form", () => page.getByTestId("password-signin-submit").click(), { timeout: 10_000 });
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/dashboard/${salon.slug}/center`);
    await test.step("Wait for front desk", () => expect(page.getByTestId("receptionist-center-loaded")).toBeVisible());
    const before = (await assertSecure(context)).map(cookie => cookie.value).join("");
    // Move browser time beyond the local 15-minute token lifetime, but keep
    // timers running normally. Wait for the SDK's real 30-second refresh tick.
    // No client object, session or provider response is replaced.
    const response = page.waitForResponse(r => {
      const url = new URL(r.url());
      return url.host === authUrl.host && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token";
    }, { timeout: 45_000 });
    await page.bringToFront();
    await test.step("Advance browser date without skipping timers", () => page.clock.setSystemTime(Date.now() + 16 * 60_000), { timeout: 10_000 });
    expect((await response).status()).toBe(200);
    expect(localRefreshes).toBeGreaterThan(0);
    await expect.poll(async () => (await sessionCookies(context)).map(cookie => cookie.value).join("") !== before).toBe(true);
    await assertSecure(context);
  }, async () => {
    await page.clock.setSystemTime(Date.now());
    await page.goto("about:blank");
    // Drain real Auth transport callbacks before closing their context or
    // removing the QA user. Do not suppress errors from unfinished requests.
    await context.unrouteAll({ behavior: "wait" });
  }, () => cleanupTestSalon(salon.slug), async () => { if (user) await cleanupTestUser(user.userId); });
});
