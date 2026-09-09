import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Exercise the real Next action decoder, but keep every write in the browser.
// These cases cannot send recovery emails or mutate an Auth account.
const buildId = readFileSync(".next/BUILD_ID", "utf8").trim();
const email = "e2e-password-recovery@example.com";
const copy = {
  en: {
    unconfirmed: "We could not confirm whether your request completed. Wait a few minutes, then try again.",
    serverError: "Something went wrong. Try again.",
  },
  vi: {
    unconfirmed: "Chưa thể xác nhận yêu cầu đã hoàn tất. Hãy đợi vài phút rồi thử lại.",
    serverError: "Có lỗi xảy ra. Thử lại.",
  },
};

for (const language of ["en", "vi"] as const) {
  for (const fault of ["429", "503", "abort", "typed-error"] as const) {
    test(`${language} ${fault}: recovery request preserves email until an explicit retry is acknowledged`, async ({ page, context }, info) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(lang => localStorage.setItem("nailiq-user-lang", lang), language);
      let calls = 0;
      let acknowledge = false;
      await context.route("**/*", async route => {
        const request = route.request();
        if (request.method() === "GET" || request.method() === "HEAD") {
          if (new URL(request.url()).origin !== new URL(String(info.project.use.baseURL)).origin) {
            return route.abort("blockedbyclient");
          }
          return route.continue();
        }
        if (!request.headers()["next-action"]) return route.fulfill({ status: 204, body: "" });
        calls++;
        if (!acknowledge && fault === "abort") return route.abort("failed");
        if (!acknowledge && (fault === "429" || fault === "503")) {
          return route.fulfill({ status: Number(fault), contentType: "text/plain",
            headers: { "Retry-After": "60" }, body: "QA transport detail; never show as form copy" });
        }
        const result = acknowledge ? { ok: true } : { ok: false, error: "server_error" };
        return route.fulfill({ status: 200, contentType: "text/x-component",
          body: `0:${JSON.stringify({ a: "$@1", f: "", q: "", i: false, b: buildId })}\n1:${JSON.stringify(result)}\n` });
      });
      await page.goto("/login/forgot-password");
      const form = page.getByTestId("salon-owner-forgot-password-form");
      const input = form.locator('input[type="email"]');
      const submit = form.getByRole("button", { name: language === "vi" ? "Gửi link đặt lại" : "Send reset link", exact: true });
      await input.fill(email);
      await submit.click();
      await expect(form.getByRole("alert")).toHaveText(fault === "typed-error" ? copy[language].serverError : copy[language].unconfirmed);
      await expect(input).toHaveValue(email);
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(submit).toBeEnabled();
      await expect(page.getByTestId("salon-owner-forgot-password-sent")).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe("/login/forgot-password");
      expect(calls).toBe(1);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: info.outputPath("request-failure.png"), fullPage: true });

      // Editing dismisses the error without submitting or claiming delivery.
      await input.fill("e2e-password-edited@example.com");
      await expect(form.getByRole("alert")).toHaveCount(0);
      await expect(input).toHaveAttribute("aria-invalid", "false");
      expect(calls).toBe(1);
      acknowledge = true;
      await submit.click();
      await expect(page.getByTestId("salon-owner-forgot-password-sent")).toBeVisible();
      await expect(form).toHaveCount(0);
      expect(calls).toBe(2);
      expect(errors).toEqual([]);
    });
  }
}
