import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Browser boundary tests: every auth POST is intercepted. No Auth user, email,
// salon, provider call, or database fixture is needed. Real Auth is covered by
// auth-signup-confirmation.spec.ts in the same real-auth CI shard.
const buildId = readFileSync(".next/BUILD_ID", "utf8").trim();
const email = "e2e-auth-recovery@example.com";
const password = "LocalFixtureOnly123!";
const copy = {
  en: {
    failed: "We could not confirm whether your request completed. Wait a few minutes, then try again.",
    limited: "Too many attempts. Wait a few minutes, then try again.",
    confirmation: "Check your email to finish",
    magic: "Forgot password? Send a login link",
    resend: "Request another confirmation link",
  },
  vi: {
    failed: "Chưa thể xác nhận yêu cầu đã hoàn tất. Hãy đợi vài phút rồi thử lại.",
    limited: "Bạn đã thử quá nhiều lần. Hãy đợi vài phút rồi thử lại.",
    confirmation: "Kiểm tra email để hoàn tất",
    magic: "Quên mật khẩu? Gửi link đăng nhập vào email",
    resend: "Yêu cầu gửi lại link xác nhận",
  },
} as const;

async function assertDraft(page: Page) {
  await expect(page.locator('input[inputmode="email"]')).toHaveValue(email);
  await expect(page.locator('input[type="password"]')).toHaveValue(password);
}

for (const language of ["en", "vi"] as const) {
  for (const action of ["signup", "signin", "magic", "resend"] as const) {
    test(`${language} ${action}: interrupted requests keep the form and allow a manual retry`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(lang => localStorage.setItem("nailiq-user-lang", lang), language);
      if (action === "resend") test.setTimeout(120_000);
      let calls = 0;
      let fault: "none" | "429" | "503" | "abort" | "typed-limit" | "typed-unavailable" = "none";
      await page.route("**/*", async route => {
        const request = route.request();
        if (request.method() !== "POST") return route.continue();
        // Fail closed: even unrelated background writes stay in this browser.
        if (!request.headers()["next-action"]) {
          return route.fulfill({ status: 204, body: "" });
        }
        calls++;
        if (fault === "abort") return route.abort("failed");
        if (fault === "429" || fault === "503") {
          return route.fulfill({
            status: Number(fault),
            contentType: "text/plain; charset=utf-8",
            headers: { "Retry-After": fault === "429" ? "60" : "30" },
            body: fault === "429"
              ? "Too many sign-in attempts. Please try again in a minute."
              : "QA transport detail that must not appear in the form",
          });
        }
        const result = fault === "typed-limit"
          ? { ok: false, error: "rate_limited" }
          : fault === "typed-unavailable" ? { ok: false, error: "server_error" }
          : action === "magic" ? { success: true }
            : action === "signin" ? { ok: false, error: "invalid_credentials" }
              : { ok: true, status: "confirmation_required", delivery: "requested" };
        // A minimal Flight envelope exercises the installed Next action decoder.
        // Resend needs its own successful result after the initial signup.
        const body = action === "resend" && calls > 1 && fault === "none"
          ? { ok: true, status: "requested" } : result;
        return route.fulfill({ status: 200, contentType: "text/x-component",
          body: `0:${JSON.stringify({ a: "$@1", f: "", q: "", i: false, b: buildId })}\n1:${JSON.stringify(body)}\n` });
      });
      const path = action === "signin" ? "/login" : "/register";
      await page.goto(path);
      await expect(page.getByTestId("password-signin-submit")).toBeEnabled();
      await page.locator('input[inputmode="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      if (action === "resend") {
        await page.getByTestId("password-signup-submit").click();
        await expect(page.getByRole("heading", { name: copy[language].confirmation, exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: copy[language].resend, exact: true })).toBeEnabled({ timeout: 70_000 });
      }
      const submit = action === "magic"
        ? page.getByRole("button", { name: copy[language].magic, exact: true })
        : action === "resend"
          ? page.getByRole("button", { name: copy[language].resend, exact: true })
          : page.getByTestId(`password-${action}-submit`);
      const faults = action === "magic"
        ? ["429", "503", "abort"] as const
        : ["429", "503", "abort", "typed-limit", "typed-unavailable"] as const;
      for (const nextFault of faults) {
        fault = nextFault;
        const before = calls;
        await submit.click();
        const alert = page.locator('main [role="alert"]');
        await expect(alert).toHaveText(nextFault === "typed-limit" ? copy[language].limited : copy[language].failed);
        await expect(submit).toBeEnabled();
        expect(calls).toBe(before + 1); // No automatic replay after an uncertain result.
        expect(new URL(page.url()).pathname).toBe(path);
        if (action !== "resend") await assertDraft(page);
        else await expect(page.getByText(email, { exact: false })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        if (nextFault === "429") {
          await page.screenshot({ path: info.outputPath("inline-failure.png"), fullPage: true });
          const axe = await new AxeBuilder({ page }).include('main [role="alert"]').withRules(["color-contrast"]).analyze();
          expect(axe.violations).toEqual([]);
        }
      }
      fault = "none";
      const before = calls;
      await submit.click();
      if (action === "signup") {
        await expect(page.getByRole("heading", { name: copy[language].confirmation, exact: true })).toBeVisible();
      } else if (action === "signin") {
        await assertDraft(page);
        await expect(submit).toBeEnabled();
        await expect(page.locator('main [role="alert"]')).not.toHaveText(copy[language].failed);
      } else if (action === "resend") {
        await expect(page.getByRole("status")).toBeVisible();
        await expect(submit).toBeHidden(); // The countdown label replaces it.
      } else {
        await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
      }
      expect(calls).toBe(before + 1);
      if (action !== "signin") await expect(page.locator('main [role="alert"]')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
}
