import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, devices, type Page, type BrowserContext } from "@playwright/test";

import { test, localAuthHttpsOrigin } from "./helpers/localAuthHttps";
import { removeLocalAuthMail, withLocalAuthCleanup } from "./helpers/localAuthCleanup";
import { seedTestSuperadmin, type SeededSuperAdmin } from "./helpers/superadmin";

const authUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid");
if (
  !["localhost", "127.0.0.1"].includes(authUrl.hostname) ||
  authUrl.protocol !== "http:" ||
  process.env.NEXT_PUBLIC_SITE_URL !== localAuthHttpsOrigin ||
  process.env.DEMO_OTP !== "false" ||
  process.env.NEXT_PUBLIC_DEMO_OTP !== "false" ||
  (process.env.PASSWORD_RECOVERY_SIGNING_SECRET?.length ?? 0) < 32
) {
  throw new Error("Password recovery requires disposable local Auth, HTTPS and demo disabled");
}

const admin = createClient(authUrl.origin, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const mailbox = "http://127.0.0.1:54324";

// Auth tokens and random passwords must never be recorded in a Playwright trace.
test.use({ baseURL: localAuthHttpsOrigin, ignoreHTTPSErrors: true, trace: "off", video: "off" });

async function localTrafficOnly(context: BrowserContext) {
  // Each synthetic browser represents a different client. Keep real rate
  // limits enabled without pooling all cases into the proxy's loopback IP.
  const groups = randomBytes(8).toString("hex").match(/.{4}/g)!;
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `2001:db8:${groups.join(":")}:1:1` });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

test.beforeEach(async ({ context }) => {
  await localTrafficOnly(context);
});

async function cleanupAccount(account: SeededSuperAdmin) {
  // Scope every write and verify cleanup instead of ignoring SDK errors.
  expect(account.email.startsWith("e2e-superadmin-")).toBe(true);
  expect(account.email.endsWith("@nailiq.test.invalid")).toBe(true);
  await withLocalAuthCleanup(
    async () => {
      const result = await admin.from("superadmin_audit_logs").delete().eq("actor_user_id", account.userId);
      expect(result.error).toBeNull();
    },
    async () => {
      const result = await admin.from("superadmins").delete().eq("user_id", account.userId);
      expect(result.error).toBeNull();
    },
    async () => {
      const result = await admin.auth.admin.deleteUser(account.userId);
      expect(result.error).toBeNull();
      const remaining = await admin.auth.admin.getUserById(account.userId);
      expect(remaining.data.user).toBeNull();
      expect(remaining.error?.status).toBe(404);
    },
  );
}

async function requestRecovery(page: Page, account: SeededSuperAdmin) {
  await page.goto("/superadmin/forgot-password");
  const form = page.getByTestId("superadmin-forgot-password-form");
  await expect(form).toBeVisible();
  await form.locator('input[type="email"]').fill(account.email);
  await form.getByRole("button", { name: /Send reset link/ }).click();
  await expect(page.getByTestId("superadmin-forgot-password-sent")).toBeVisible();
  let messageId = "";
  await expect.poll(async () => {
    const response = await page.request.get(mailbox + "/api/v1/messages");
    expect(response.ok()).toBe(true);
    const data = await response.json() as { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
    messageId = data.messages.find((message) => message.To.some((to) => to.Address === account.email))?.ID ?? "";
    return Boolean(messageId);
  }).toBe(true);
  const response = await page.request.get(mailbox + "/api/v1/message/" + encodeURIComponent(messageId));
  expect(response.ok()).toBe(true);
  const message = await response.json() as { Text: string };
  const raw = message.Text.match(/https?:\/\/[^\s<>"()]+/)?.[0];
  expect(Boolean(raw), "Mailpit must contain the real recovery link").toBe(true);
  const link = new URL(raw!);
  expect(link.origin).toBe(authUrl.origin);
  expect(link.pathname).toBe("/auth/v1/verify");
  const destination = new URL(link.searchParams.get("redirect_to")!);
  expect(destination.origin).toBe(localAuthHttpsOrigin);
  expect(destination.pathname).toBe("/auth/recovery");
  expect(destination.searchParams.get("surface")).toBe("superadmin");
  expect(Boolean(destination.searchParams.get("state"))).toBe(true);
  // Transport only: GoTrue still consumes the original token and issues PKCE.
  return localAuthHttpsOrigin + "/__qa_auth_verify" + link.search;
}

async function openRecovery(page: Page, link: string) {
  await page.goto(link);
  // Path-only assertions keep recovery codes and signed state out of failures.
  await expect.poll(() => new URL(page.url()).pathname).toBe("/superadmin/reset-password");
  const form = page.getByTestId("superadmin-reset-password-form");
  await expect(form.locator('input[type="password"]').first()).toBeEnabled();
  const cookies = await page.context().cookies();
  const capability = cookies.find((cookie) => cookie.name === "nq-password-recovery");
  expect(Boolean(capability), "A real recovery capability must be issued").toBe(true);
  expect(capability?.httpOnly).toBe(true);
  expect(capability?.secure).toBe(true);
  expect(cookies.some((cookie) => cookie.name === "nailiq-demo-slug")).toBe(false);
  return form;
}

async function revokeRole(account: SeededSuperAdmin) {
  const result = await admin.from("superadmins").update({ revoked_at: new Date().toISOString() })
    .eq("user_id", account.userId).select("user_id, revoked_at").single();
  expect(result.error).toBeNull();
  expect(result.data?.user_id).toBe(account.userId);
  expect(Boolean(result.data?.revoked_at)).toBe(true);
}

async function passwordAccepted(account: SeededSuperAdmin, password: string) {
  const client = createClient(authUrl.origin, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const result = await client.auth.signInWithPassword({ email: account.email, password });
    if (result.error) {
      expect(result.error.code).toBe("invalid_credentials");
      return false;
    }
    expect(result.data.user?.id).toBe(account.userId);
    return true;
  } finally {
    const result = await client.auth.signOut({ scope: "local" });
    expect(result.error).toBeNull();
  }
}

for (const role of ["founder", "ops_admin", "support_admin", "billing_admin", "ai_admin", "readonly_analyst"] as const) {
  test(`${role}: valid link changes the password, consumes recovery and rejects reuse`, async ({ page }) => {
    const account = await seedTestSuperadmin({ role });
    const password = randomBytes(24).toString("base64url") + "#Aa1";
    await withLocalAuthCleanup(async () => {
      const link = await requestRecovery(page, account);
      const form = await openRecovery(page, link);
      await test.info().attach("recovery-form", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await form.locator('input[type="password"]').nth(0).fill(password);
      await form.locator('input[type="password"]').nth(1).fill(password);
      await form.getByRole("button", { name: /Set new password/ }).click();
      await expect(page).toHaveURL(localAuthHttpsOrigin + "/superadmin/login?reset=ok");
      expect((await page.context().cookies()).some((cookie) => cookie.name === "nq-password-recovery")).toBe(false);
      expect(await passwordAccepted(account, account.password)).toBe(false);
      const login = page.getByTestId("superadmin-login-form");
      await login.locator('input[type="email"]').fill(account.email);
      await login.locator('input[type="password"]').fill(password);
      await login.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(/\/superadmin\/dashboard$/);
      await page.goto(link);
      await expect(page).toHaveURL(/\/superadmin\/forgot-password\?notice=invalid_or_expired/);
      await expect(page.getByTestId("superadmin-reset-password-form")).toHaveCount(0);
    }, () => removeLocalAuthMail(account.email), () => cleanupAccount(account));
  });
}

test("a link opened in a different browser cannot change the password", async ({ page, browser }) => {
  const account = await seedTestSuperadmin();
  await withLocalAuthCleanup(async () => {
    const link = await requestRecovery(page, account);
    const fresh = await browser.newContext({
      ...(test.info().project.name === "mobile" ? devices["iPhone 14"] : {}),
      ignoreHTTPSErrors: true,
    });
    await withLocalAuthCleanup(async () => {
      await localTrafficOnly(fresh);
      const other = await fresh.newPage();
      await other.goto(link);
      await expect(other).toHaveURL(/\/superadmin\/forgot-password\?notice=invalid_or_expired/);
      await expect(other.getByTestId("superadmin-reset-password-form")).toHaveCount(0);
      expect((await fresh.cookies()).some((cookie) => cookie.name === "nq-password-recovery")).toBe(false);
      expect(await passwordAccepted(account, account.password)).toBe(true);
    }, () => fresh.close());
  }, () => removeLocalAuthMail(account.email), () => cleanupAccount(account));
});

test("a role revoked before opening the link cannot obtain a reset form", async ({ page }) => {
  const account = await seedTestSuperadmin();
  await withLocalAuthCleanup(async () => {
    const link = await requestRecovery(page, account);
    await revokeRole(account);
    await page.goto(link);
    await expect(page).toHaveURL(/\/superadmin\/forgot-password\?notice=invalid_or_expired/);
    await expect(page.getByTestId("superadmin-reset-password-form")).toHaveCount(0);
    expect((await page.context().cookies()).some((cookie) => cookie.name === "nq-password-recovery")).toBe(false);
    expect(await passwordAccepted(account, account.password)).toBe(true);
  }, () => removeLocalAuthMail(account.email), () => cleanupAccount(account));
});

test("revoking a role while the form is open blocks the password update", async ({ page }) => {
  const account = await seedTestSuperadmin();
  const password = randomBytes(24).toString("base64url") + "#Aa1";
  await withLocalAuthCleanup(async () => {
    const link = await requestRecovery(page, account);
    const form = await openRecovery(page, link);
    await revokeRole(account);
    await form.locator('input[type="password"]').nth(0).fill(password);
    await form.locator('input[type="password"]').nth(1).fill(password);
    await form.getByRole("button", { name: /Set new password/ }).click();
    // Revocation signs out the recovery session. The ensuing server render
    // redirects to the invalid-link notice before a no-role alert can persist.
    await expect.poll(() => new URL(page.url()).pathname).toBe("/superadmin/forgot-password");
    expect(new URL(page.url()).searchParams.get("notice")).toBe("invalid_or_expired");
    await expect(page.getByTestId("superadmin-reset-password-form")).toHaveCount(0);
    expect(await passwordAccepted(account, password)).toBe(false);
    expect(await passwordAccepted(account, account.password)).toBe(true);
  }, () => removeLocalAuthMail(account.email), () => cleanupAccount(account));
});
