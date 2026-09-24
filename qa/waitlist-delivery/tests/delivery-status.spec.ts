import { expect, test } from "@playwright/test";

const copy = {
  en: {
    accepted: "SMS · Provider accepted",
    delivered: "Email · Delivered",
    failed: "SMS · Failed",
    suppressed: "Email · Customer opted out",
    unknown: "SMS · Not verified",
    sending: "Email · Sending",
    responseTitle: "Waiting for customer response",
    blockedTitle: "Notification needs attention",
    pendingTitle: "Notification in progress",
    unverifiedTitle: "Delivery not confirmed",
    date: "Sep 20, 2026",
    duration: "Waiting 9 days 12 hr 37 min",
    group: "2 guests · 1 service",
  },
  vi: {
    accepted: "SMS · Đơn vị gửi đã nhận",
    delivered: "Email · Đã giao",
    failed: "SMS · Gửi thất bại",
    suppressed: "Email · Khách đã từ chối",
    unknown: "SMS · Chưa xác minh",
    sending: "Email · Đang gửi",
    responseTitle: "Đang chờ khách phản hồi",
    blockedTitle: "Cần kiểm tra thông báo",
    pendingTitle: "Thông báo đang được gửi",
    unverifiedTitle: "Chưa xác nhận giao thông báo",
    date: "20 thg 9, 2026",
    duration: "Đã chờ 9 ngày 12 giờ 37 phút",
    group: "2 khách · 1 dịch vụ",
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
    const acceptedRow = page.getByTestId("waitlist-delivery-delivery-accepted");
    const failedRow = page.getByTestId("waitlist-delivery-delivery-failed");
    const unknownRow = page.getByTestId("waitlist-delivery-delivery-unknown");
    const accepted = acceptedRow.getByText(labels.accepted, { exact: true }).locator("..");
    const delivered = acceptedRow.getByText(labels.delivered, { exact: true }).locator("..");
    const failed = failedRow.getByText(labels.failed, { exact: true }).locator("..");
    const suppressed = failedRow.getByText(labels.suppressed, { exact: true }).locator("..");
    const unknown = unknownRow.getByText(labels.unknown, { exact: true }).locator("..");
    const sending = unknownRow.getByText(labels.sending, { exact: true }).locator("..");
    for (const badge of [accepted, delivered, failed, suppressed, unknown, sending]) {
      await expect(badge).toBeVisible();
    }
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

    // Delivery guidance must not change the operational permission classifier.
    for (const [id, guidance, title] of [
      ["accepted", "delivered", labels.responseTitle],
      ["failed", "blocked", labels.blockedTitle],
      ["unknown", "pending", labels.pendingTitle],
      ["accepted-only", "unverified", labels.unverifiedTitle],
      ["partial", "delivered", labels.responseTitle],
      ["missing", "unverified", labels.unverifiedTitle],
    ] as const) {
      const row = page.getByTestId(`waitlist-autonomy-delivery-${id}`);
      await expect(row).toHaveAttribute("data-delivery-guidance", guidance);
      await expect(row).toHaveAttribute("data-autonomy-lane", "auto_safe");
      await expect(row.getByText(title, { exact: true })).toBeVisible();
      await expect(page.getByTestId(`waitlist-invite-delivery-${id}`)).toBeEnabled();
      if (guidance !== "delivered") {
        await expect(row).not.toHaveClass(/bg-nq-success/);
        await expect(row).not.toContainText(labels.responseTitle);
        await expect(row).not.toContainText(language === "vi" ? "NailIQ tự xử lý" : "NailIQ autopilot");
      }
    }
    await expect(page.getByTestId("waitlist-autonomy-delivery-failed")).toContainText(
      language === "vi" ? "Tôn trọng lựa chọn từ chối nhận tin" : "Respect opt-outs",
    );
    await expect(page.getByTestId("waitlist-delivery-delivery-partial")).toContainText(
      language === "vi" ? "Email · Gửi thất bại" : "Email · Failed",
    );
    for (const [id, lane] of [
      ["waiting", "auto_safe"], ["group", "approval_required"], ["claimed", "human_exception"],
    ]) {
      const row = page.getByTestId(`waitlist-autonomy-delivery-${id}`);
      await expect(row).toHaveAttribute("data-autonomy-lane", lane);
      await expect(row).not.toHaveAttribute("data-delivery-guidance");
    }
    await expect(page.getByTestId("waitlist-invite-delivery-group")).toHaveCount(0);
    await expect(page.getByTestId("waitlist-arrange-delivery-group")).toBeVisible();
    await expect(page.getByTestId("waitlist-create-delivery-claimed")).toBeVisible();
    const groupEntry = page.getByTestId("waitlist-entry-delivery-group");
    await expect(groupEntry).toContainText(labels.group);
    await expect(groupEntry).toContainText(labels.date);
    await expect(groupEntry).not.toContainText("2026-09-20");

    // Read-only customer details: no send, call, or booking click.
    await expect(page.getByTestId("waitlist-customer-details")).toHaveCount(0);
    await expect(page.getByText("qa@example.test", { exact: true })).toHaveCount(0);
    const nameButton = page.getByRole("button", { name: /QA Failed/ });
    await nameButton.focus();
    await page.keyboard.press("Enter");
    const details = page.getByTestId("waitlist-customer-details");
    await expect(details).toBeVisible();
    await expect(details).toContainText("qa@example.test");
    await expect(details).toContainText(labels.date);
    await expect(details).toContainText(labels.duration);
    await expect(details).not.toContainText("13717");
    if (language === "vi") {
      await expect(details).not.toContainText(/Waitlist|Provider/);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await testInfo.attach(`waitlist-details-${language}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0);
    await expect(nameButton).toBeFocused();
    await nameButton.click();
    await expect(details).toBeVisible();
    await page.getByRole("button", { name: language === "vi" ? "Đóng thông tin khách" : "Close customer details", exact: true }).click();
    await expect(details).toHaveCount(0);
    await expect(nameButton).toBeFocused();
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
