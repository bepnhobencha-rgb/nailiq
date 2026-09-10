import { expect, devices, type Page } from "@playwright/test";

import { test, localAuthHttpsOrigin } from "./helpers/localAuthHttps";
import {
  removeLocalAuthMail,
  withLocalAuthCleanup,
} from "./helpers/localAuthCleanup";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalon,
  seedTestSalonMember,
  seedTestUser,
} from "./helpers/db";

// This spec sends Auth mail only into the disposable stack's local Mailpit.
// Refuse a hosted Auth endpoint before a browser can request any email.
const authUrl = new URL(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://invalid",
);
if (
  !["localhost", "127.0.0.1"].includes(authUrl.hostname) ||
  authUrl.protocol !== "http:"
) {
  throw new Error(
    "Auth callback tests require the local disposable Supabase stack",
  );
}
test.use({ baseURL: localAuthHttpsOrigin, ignoreHTTPSErrors: true, trace: "off", video: "off", screenshot: "off" });
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) if (!page.isClosed()) await page.goto("about:blank");
});
const mailbox = "http://127.0.0.1:54324";
const retryCopy = {
  en: "We couldn't complete sign-in. Please try again.",
  vi: "Không thể hoàn tất đăng nhập. Vui lòng thử lại.",
};

async function requestLocalMagicLink(page: Page, email: string) {
  await page.goto("/register");
  await expect(page.getByTestId("password-signin-submit")).toBeEnabled();
  await page.locator('input[inputmode="email"]').fill(email);
  await page
    .getByRole("button", {
      name: "Forgot password? Send a login link",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox", exact: true }),
  ).toBeVisible();
  const pkceCookies = (await page.context().cookies()).filter(cookie => cookie.name.includes("-code-verifier"));
  expect(pkceCookies.length).toBeGreaterThan(0);
  expect(pkceCookies.every(cookie => cookie.secure)).toBe(true);
  let messageId = "";
  await expect
    .poll(async () => {
      const response = await page.request.get(mailbox + "/api/v1/messages");
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as {
        messages: Array<{ ID: string; To: Array<{ Address: string }> }>;
      };
      messageId =
        body.messages.find((m) => m.To.some((to) => to.Address === email))
          ?.ID ?? "";
      return Boolean(messageId);
    })
    .toBe(true);
  const message = await page.request.get(
    mailbox + "/api/v1/message/" + encodeURIComponent(messageId),
  );
  expect(message.ok()).toBe(true);
  const { Text: text } = (await message.json()) as { Text: string };
  const raw = text.match(/https?:\/\/[^\s<>"()]+/)?.[0];
  expect(Boolean(raw), "Local mail must contain a sign-in link").toBe(true);
  const link = new URL(raw!);
  expect(link.origin).toBe(authUrl.origin);
  expect(link.pathname).toBe("/auth/v1/verify");
  expect(new URL(link.searchParams.get("redirect_to")!).pathname).toBe(
    "/auth/callback",
  );
  // Preserve the Auth token and redirect target; only transport uses local TLS.
  return {
    link: localAuthHttpsOrigin + "/__qa_auth_verify" + link.search,
    messageId,
  };
}

async function expectSecureSession(page: Page) {
  const cookies = await page.context().cookies();
  const session = cookies.filter(
    (cookie) =>
      cookie.name.startsWith("sb-") && cookie.name.includes("auth-token"),
  );
  expect(session.length).toBeGreaterThan(0);
  expect(session.every((cookie) => cookie.secure)).toBe(true);
  expect(cookies.some((cookie) => cookie.name === "nailiq-demo-slug")).toBe(
    false,
  );
}

test.describe("Auth callback error feedback", () => {
  for (const lang of ["en", "vi"] as const) {
    for (const [label, suffix] of [
      [
        "provider cancellation",
        "?error=access_denied&error_description=QA_PROVIDER_DETAIL",
      ],
      ["empty provider description", "?error=access_denied&error_description="],
      ["missing code", ""],
      ["expired-link fragment", "#error=access_denied&error_code=otp_expired"],
    ]) {
      test(`${lang}: ${label} shows a localized retry message`, async ({
        page,
      }) => {
        await page.addInitScript(
          (language) => localStorage.setItem("nailiq-user-lang", language),
          lang,
        );
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/auth/callback" + suffix);
        await expect(page).toHaveURL(/\/login\?error=session(?:#.*)?$/);
        const alert = page
          .getByRole("alert")
          .filter({ hasText: retryCopy[lang] });
        await expect(alert).toBeVisible();
        await expect(page.getByTestId("password-signin-submit")).toBeEnabled();
        expect(page.url()).not.toContain("QA_PROVIDER_DETAIL");
        expect(
          (await page.context().cookies()).some(
            (cookie) => cookie.name === "nailiq-demo-slug",
          ),
        ).toBe(false);
        expect(errors).toEqual([]);
        await test
          .info()
          .attach("callback-retry", {
            body: await page.screenshot(),
            contentType: "image/png",
          });
      });
    }
  }
});

test.describe("Local email link and real PKCE callback", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem("nailiq-user-lang", "en"),
    );
  });

  test("new user keeps the session after callback; reused link shows an error", async ({
    page,
    browser,
  }) => {
    const user = await seedTestUser();
    await withLocalAuthCleanup(async () => {
      const mail = await requestLocalMagicLink(page, user.email);
      await page.goto(mail.link);
      await expect(page).toHaveURL(/\/register\/setup$/);
      await expect(page.locator("#register-setup-salon-name")).toBeEditable();
      await expectSecureSession(page);
      await page.reload();
      await expect(page.locator("#register-setup-salon-name")).toBeEditable();
      const fresh = await browser.newContext({
        ...(test.info().project.name === "mobile" ? devices["iPhone 14"] : {}),
        ignoreHTTPSErrors: true,
        locale: "en-US",
      });
      await withLocalAuthCleanup(async () => {
        const other = await fresh.newPage();
        await other.goto(mail.link);
        await expect(other).toHaveURL(/\/login\?error=session(?:#.*)?$/);
        await expect(
          other.getByRole("alert").filter({ hasText: retryCopy.en }),
        ).toBeVisible();
      }, () => fresh.close());
    }, () => removeLocalAuthMail(user.email), () => cleanupTestUser(user.userId));
  });

  test("existing owner reaches their own salon after the email callback", async ({
    page,
  }) => {
    const salon = await seedTestSalon();
    const user = await seedTestSalonMember(salon.salonId, "owner");
    await withLocalAuthCleanup(async () => {
      const mail = await requestLocalMagicLink(page, user.email);
      await page.goto(mail.link);
      await expect(page).toHaveURL(new RegExp(`/dashboard/${salon.slug}$`));
      await expectSecureSession(page);
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`/dashboard/${salon.slug}$`));
      await expect(page.locator("main")).toBeVisible();
    },
    () => removeLocalAuthMail(user.email),
    () => cleanupTestSalon(salon.salonId),
    () => cleanupTestUser(user.userId));
  });

  test("a link opened in another browser explains how to restart sign-in", async ({
    page,
    browser,
  }) => {
    const user = await seedTestUser();
    await withLocalAuthCleanup(async () => {
      const mail = await requestLocalMagicLink(page, user.email);
      const fresh = await browser.newContext({
        ...(test.info().project.name === "mobile" ? devices["iPhone 14"] : {}),
        ignoreHTTPSErrors: true,
        locale: "en-US",
      });
      await withLocalAuthCleanup(async () => {
        const other = await fresh.newPage();
        await other.goto(mail.link);
        await expect(other).toHaveURL(/\/login\?error=pkce_restart$/);
        await expect(
          other
            .getByRole("alert")
            .filter({ hasText: /same browser|start.*sign.in|sign.in.*again/i }),
        ).toBeVisible();
        await expect(other.getByTestId("password-signin-submit")).toBeEnabled();
      }, () => fresh.close());
    }, () => removeLocalAuthMail(user.email), () => cleanupTestUser(user.userId));
  });
});
