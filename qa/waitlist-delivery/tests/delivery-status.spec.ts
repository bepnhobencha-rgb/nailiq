import { expect, test } from "@playwright/test";

const copy = {
  en: {
    accepted: "SMS · Provider accepted",
    delivered: "Email · Delivered",
    failed: "SMS · Failed",
    suppressed: "Email · Customer opted out",
    unknown: "SMS · Not verified",
    sending: "Email · Sending",
  },
  vi: {
    accepted: "SMS · Provider đã nhận",
    delivered: "Email · Đã giao",
    failed: "SMS · Gửi thất bại",
    suppressed: "Email · Khách đã từ chối",
    unknown: "SMS · Chưa xác minh",
    sending: "Email · Đang gửi",
  },
} as const;

for (const language of ["en", "vi"] as const) {
  test(`${language}: renders terminal delivery truth without false success`, async ({ page, context }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.addInitScript((value) => {
      window.localStorage.setItem("nailiq-user-lang", value);
    }, language);
    await context.route("**/*", (route) => {
      const request = route.request();
      const local = new URL(request.url()).origin === "http://127.0.0.1:3116";
      return local && ["GET", "HEAD"].includes(request.method())
        ? route.continue()
        : route.abort();
    });

    await page.goto(`/?lang=${language}`, { waitUntil: "networkidle" });
    const labels = copy[language];
    for (const label of Object.values(labels)) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    const accepted = page.getByText(labels.accepted, { exact: true }).locator("..");
    const delivered = page.getByText(labels.delivered, { exact: true }).locator("..");
    const failed = page.getByText(labels.failed, { exact: true }).locator("..");
    const suppressed = page.getByText(labels.suppressed, { exact: true }).locator("..");
    const unknown = page.getByText(labels.unknown, { exact: true }).locator("..");
    const sending = page.getByText(labels.sending, { exact: true }).locator("..");
    await expect(accepted).not.toHaveClass(/text-nq-success/);
    await expect(delivered).toHaveClass(/text-nq-success/);
    await expect(failed).toHaveClass(/text-nq-error/);
    await expect(suppressed).toHaveClass(/text-nq-warning/);
    await expect(unknown).toHaveClass(/text-nq-warning/);
    await expect(sending).not.toHaveClass(/text-nq-success/);

    await expect(page.getByTestId("waitlist-delivery-delivery-failed")).not.toContainText(
      language === "vi" ? "Đã giao" : "Delivered",
    );
    await expect(page.getByTestId("waitlist-delivery-delivery-unknown")).not.toContainText(
      language === "vi" ? "Đã giao" : "Delivered",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    expect(errors).toEqual([]);
    const screenshotPath = testInfo.outputPath(`waitlist-delivery-${language}.png`);
    await page.screenshot({ fullPage: true, path: screenshotPath });
    await testInfo.attach(`waitlist-delivery-${language}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  });
}
