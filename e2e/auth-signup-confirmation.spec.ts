import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { devices, expect, type Page } from "@playwright/test";
import { test, localAuthHttpsOrigin } from "./helpers/localAuthHttps";
import {
  removeLocalAuthMail,
  withLocalAuthCleanup,
} from "./helpers/localAuthCleanup";
import {
  cleanupTestUser,
  getRegisteredSalonForUser,
  setReactInputValue,
} from "./helpers/db";

// Signup must exercise real confirmation mail, but only in disposable local Auth.
const authUrl = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid",
);
if (
  !["localhost", "127.0.0.1"].includes(authUrl.hostname) ||
  authUrl.protocol !== "http:"
) {
  throw new Error("Signup confirmation requires disposable loopback Supabase");
}
const admin = createClient(
  authUrl.origin,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);
const mailbox = "http://127.0.0.1:54324";
test.use({ baseURL: localAuthHttpsOrigin, ignoreHTTPSErrors: true });

// Independent scenarios share one loopback IP in the disposable, serial shard.
// Match cleanupTestSalon's fixture isolation: keep real limits within each test,
// but do not spend a later account's quota on an earlier test's requests.
test.beforeEach(async () => {
  const { error } = await admin
    .from("rate_limits")
    .delete()
    .like("bucket", "%");
  expect(error).toBeNull();
});

async function findUser(email: string) {
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email === email);
    if (user) return user;
    if (data.users.length < 100) return null;
  }
}

async function messages(page: Page, email: string) {
  const response = await page.request.get(mailbox + "/api/v1/messages");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
  };
  return body.messages.filter((m) => m.To.some((to) => to.Address === email));
}

async function confirmationLink(
  page: Page,
  email: string,
  excludeIds: string[] = [],
) {
  const pending = async () =>
    (await messages(page, email)).filter(
      (mail) => !excludeIds.includes(mail.ID),
    );
  await expect.poll(async () => (await pending()).length).toBeGreaterThan(0);
  const [mail] = await pending();
  const response = await page.request.get(
    mailbox + "/api/v1/message/" + mail.ID,
  );
  expect(response.ok()).toBe(true);
  const { Text: text } = (await response.json()) as { Text: string };
  const raw = text.match(/https?:\/\/[^\s<>"()]+/)?.[0];
  expect(Boolean(raw), "Confirmation mail contains its verification link").toBe(
    true,
  );
  const link = new URL(raw!);
  expect(link.origin).toBe(authUrl.origin);
  expect(link.pathname).toBe("/auth/v1/verify");
  expect(link.searchParams.get("type")).toBe("signup");
  expect(new URL(link.searchParams.get("redirect_to")!).pathname).toBe(
    "/auth/callback",
  );
  return localAuthHttpsOrigin + "/__qa_auth_verify" + link.search;
}

async function signup(
  page: Page,
  email: string,
  password: string,
  lang: "en" | "vi",
) {
  await page.addInitScript(
    (language) => localStorage.setItem("nailiq-user-lang", language),
    lang,
  );
  await page.goto("/register");
  await expect(page.getByTestId("password-signin-submit")).toBeEnabled();
  await page.locator('input[inputmode="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByTestId("password-signup-submit").click();
  await expect(
    page.getByRole("heading", {
      name:
        lang === "en"
          ? "Check your email to finish"
          : "Kiểm tra email để hoàn tất",
      exact: true,
    }),
  ).toBeVisible();
}

async function cleanup(email: string) {
  await withLocalAuthCleanup(
    () => removeLocalAuthMail(email),
    async () => {
      const user = await findUser(email);
      if (user) await cleanupTestUser(user.id);
      expect(await findUser(email)).toBeNull();
    },
  );
}

for (const lang of ["en", "vi"] as const) {
  test(`${lang}: a new email signup confirms and creates a private 14-day salon`, async ({
    page,
  }) => {
    const email = `e2e-signup-${randomUUID()}@example.com`;
    const password = `Aa1!${randomBytes(24).toString("base64url")}`;
    const errors: string[] = [];
    const startedAt = Date.now();
    const browserDiagnostics: Array<{
      elapsedMs: number;
      tab: "signup" | "confirmation";
      event: "pageerror" | "requestfailed" | "reload:start" | "reload:end";
      origin: string;
      path: string;
      accessControl?: boolean;
      cancelled?: boolean;
    }> = [];
    const location = (raw: string) => {
      const url = new URL(raw);
      return { origin: url.origin, path: url.pathname };
    };
    const observe = (observed: Page, tab: "signup" | "confirmation") => {
      observed.on("pageerror", (error) => {
        errors.push(error.message);
        browserDiagnostics.push({
          elapsedMs: Date.now() - startedAt,
          tab,
          event: "pageerror",
          ...location(observed.url()),
          accessControl: /access control/i.test(error.message),
          cancelled: /abort|cancel/i.test(error.message),
        });
      });
      observed.on("requestfailed", (request) => {
        const failure = request.failure()?.errorText ?? "";
        browserDiagnostics.push({
          elapsedMs: Date.now() - startedAt,
          tab,
          event: "requestfailed",
          ...location(request.url()),
          accessControl: /access control/i.test(failure),
          cancelled: /abort|cancel/i.test(failure),
        });
      });
    };
    observe(page, "signup");
    expect(await findUser(email)).toBeNull();
    await withLocalAuthCleanup(async () => {
      await signup(page, email, password, lang);
      const user = await findUser(email);
      expect(user).not.toBeNull();
      expect(user!.email_confirmed_at).toBeFalsy();
      const memberships = await admin
        .from("salon_members")
        .select("id")
        .eq("user_id", user!.id);
      expect(memberships.error).toBeNull();
      expect(memberships.data).toEqual([]);
      const setupBeforeConfirmation = await page.request.get(
        localAuthHttpsOrigin + "/register/setup",
      );
      expect(new URL(setupBeforeConfirmation.url()).pathname).toBe("/register");
      await test.info().attach("confirmation-required", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      const link = await confirmationLink(page, email);
      // Mail opens a new tab in the same browser, preserving the PKCE cookie.
      // Keep the source page alive so its prefetch is not cancelled by the test.
      page = await page.context().newPage();
      observe(page, "confirmation");
      await page.goto(link);
      await expect(page).toHaveURL(/\/register\/setup$/);
      await expect(page.locator("#register-setup-salon-name")).toBeEditable();
      expect((await findUser(email))?.email_confirmed_at).toBeTruthy();
      const cookies = await page.context().cookies();
      const sessions = cookies.filter((cookie) =>
        /-auth-token(?:\.\d+)?$/.test(cookie.name),
      );
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every((cookie) => cookie.secure)).toBe(true);
      expect(cookies.some((cookie) => cookie.name === "nailiq-demo-slug")).toBe(
        false,
      );
      browserDiagnostics.push({
        elapsedMs: Date.now() - startedAt,
        tab: "confirmation",
        event: "reload:start",
        ...location(page.url()),
      });
      await page.reload();
      browserDiagnostics.push({
        elapsedMs: Date.now() - startedAt,
        tab: "confirmation",
        event: "reload:end",
        ...location(page.url()),
      });
      await expect(page.locator("#register-setup-salon-name")).toBeEditable();

      const salonName = `E2E Signup ${user!.id.slice(0, 8)}`;
      const createButton = page.getByRole("button", {
        name: /create salon workspace|tạo không gian salon/i,
      });
      await expect(async () => {
        await setReactInputValue(
          page.locator("#register-setup-salon-name"),
          salonName,
        );
        await expect(createButton).toBeEnabled();
      }).toPass({ timeout: 15_000 });
      const beforeCreate = Date.now();
      await createButton.click();
      await expect(page).toHaveURL(/\/register\/success\?/, {
        timeout: 30_000,
      });
      await expect(
        page.getByTestId("registration-launch-status"),
      ).toContainText(/not live yet|chưa Live/i);
      const registered = await getRegisteredSalonForUser(user!.id);
      expect(registered.memberRole).toBe("owner");
      expect(registered.salon.name).toBe(salonName);
      expect(registered.salon.subscription_status).toBe("trialing");
      expect(
        Date.parse(registered.salon.trial_started_at!),
      ).toBeGreaterThanOrEqual(beforeCreate);
      expect(
        Date.parse(registered.salon.trial_ends_at!) -
          Date.parse(registered.salon.trial_started_at!),
      ).toBe(14 * 24 * 60 * 60 * 1_000);
      expect(registered.salon.stripe_customer_id).toBeNull();
      expect(registered.salon.stripe_subscription_id).toBeNull();
      expect(registered.salon.payment_provider).toBeNull();
      expect(registered.salon.sms_outbound_enabled).toBe(false);
      expect(registered.salon.email_outbound_enabled).toBe(false);
      expect(registered.salon.profile_complete).toBe(false);
      await page
        .getByRole("button", {
          name: /start coco setup|bắt đầu coco setup|go to dashboard|vào bảng điều khiển/i,
        })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/dashboard/${registered.salon.slug}(?:[/?#]|$)`),
      );
      await expect(page.locator("main")).toBeVisible();
      expect(errors).toEqual([]);
    }, async () => {
      await test.info().attach("auth-browser-diagnostics", {
        body: JSON.stringify(browserDiagnostics),
        contentType: "application/json",
      });
    }, () => cleanup(email));
  });
}

test("requesting another confirmation email keeps the signup usable", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const email = `e2e-signup-${randomUUID()}@example.com`;
  const password = `Aa1!${randomBytes(24).toString("base64url")}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await withLocalAuthCleanup(async () => {
    await signup(page, email, password, "en");
    await confirmationLink(page, email);
    const originalIds = (await messages(page, email)).map((mail) => mail.ID);
    const resend = page.getByRole("button", {
      name: /Request another (?:confirmation )?link/i,
    });
    await expect(resend).toBeDisabled();
    await expect(resend).toBeEnabled({ timeout: 70_000 });
    await resend.click();
    await expect(page.getByRole("status")).toHaveText(
      "Another confirmation email was requested.",
    );
    const link = await confirmationLink(page, email, originalIds);
    expect((await findUser(email))?.email_confirmed_at).toBeFalsy();
    page = await page.context().newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(link);
    await expect(page).toHaveURL(/\/register\/setup$/);
    await expect(page.locator("#register-setup-salon-name")).toBeEditable();
    expect((await findUser(email))?.email_confirmed_at).toBeTruthy();
    const sessions = (await page.context().cookies()).filter((cookie) =>
      /-auth-token(?:\.\d+)?$/.test(cookie.name),
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((cookie) => cookie.secure)).toBe(true);
    expect(new URL(page.url()).hash).toBe("");
    await page.reload();
    await expect(page.locator("#register-setup-salon-name")).toBeEditable();
    expect(errors).toEqual([]);
  }, () => cleanup(email));
});

test("confirmation opened in another browser can continue with password sign-in", async ({
  page,
  browser,
}) => {
  const email = `e2e-signup-${randomUUID()}@example.com`;
  const password = `Aa1!${randomBytes(24).toString("base64url")}`;
  await withLocalAuthCleanup(async () => {
    await signup(page, email, password, "en");
    const link = await confirmationLink(page, email);
    const other = await browser.newContext({
      ...(test.info().project.name === "mobile" ? devices["iPhone 14"] : {}),
      ignoreHTTPSErrors: true,
      locale: "en-US",
    });
    await withLocalAuthCleanup(async () => {
      const tab = await other.newPage();
      const errors: string[] = [];
      tab.on("pageerror", (error) => errors.push(error.message));
      await tab.goto(link);
      await expect(tab).toHaveURL(/\/login\?error=pkce_restart$/);
      await expect(
        tab
          .getByRole("alert")
          .filter({ hasText: /same browser|start.*sign.in|sign.in.*again/i }),
      ).toBeVisible();
      expect((await findUser(email))?.email_confirmed_at).toBeTruthy();
      await expect(tab.getByTestId("password-signin-submit")).toBeEnabled();
      await tab.locator('input[inputmode="email"]').fill(email);
      await tab.locator('input[type="password"]').fill(password);
      await tab.waitForLoadState("networkidle");
      await tab.getByTestId("password-signin-submit").click();
      await expect(tab).toHaveURL(/\/register\/setup$/);
      await expect(tab.locator("#register-setup-salon-name")).toBeEditable();
      await tab.reload();
      await expect(tab.locator("#register-setup-salon-name")).toBeEditable();
      expect(errors).toEqual([]);
    }, () => other.close());
  }, () => cleanup(email));
});
