import { test, expect } from "@playwright/test";

const origin = "https://nailiq-p0-signup-qa-20260911.vercel.app";
const slug = process.env.NAILIQ_QA_OTP_SLUG ?? "";
const accessUrl = process.env.NAILIQ_QA_PREVIEW_ACCESS_URL ?? "";
if (process.env.PLAYWRIGHT_BASE_URL !== origin || !/^e2e-otp-preview-[a-f0-9]{8}$/.test(slug) || new URL(accessUrl).origin !== origin) {
  throw new Error("OTP locale test requires the pinned synthetic QA fixture and Preview access");
}

test.beforeEach(async ({ page }) => {
  await page.goto(accessUrl);
  await page.goto(`${origin}/${slug}?lang=en`);
  await expect(page.getByRole("textbox", { name: "Phone number", exact: true })).toBeVisible();
  // The public gate exposes readiness after its event handlers attach.
  await expect(page.getByTestId("booking-entry-hydrated")).toBeAttached();
  await page.getByRole("textbox", { name: "Phone number", exact: true }).fill("6045550196");
  await page.getByRole("textbox", { name: "Your name", exact: true }).fill("QA Locale Guest");
  await expect(page.getByRole("button", { name: "Send code", exact: true })).toBeVisible();
});

for (const channel of ["sms", "email"] as const) {
  test(`${channel} error follows EN to VI to EN without another send`, async ({ page }) => {
    let requests = 0;
    await page.route("**/api/booking-otp/send", async (route) => {
      requests++;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: `${channel}_suppressed` }) });
    });
    if (channel === "email") {
      await page.getByRole("button", { name: "Didn't get the text? Email me the code", exact: true }).click();
      await page.getByRole("textbox", { name: "you@email.com", exact: true }).fill("locale@example.test");
    }
    await page.getByRole("button", { name: channel === "email" ? "Send code by email" : "Send code", exact: true }).click();
    const error = page.getByTestId("booking-gate-otp-error");
    const en = channel === "email" ? "Couldn't send email. Please try again." : "Couldn't send SMS. Please try again.";
    const vi = channel === "email" ? "Không gửi được email. Vui lòng thử lại." : "Không gửi được SMS. Vui lòng thử lại.";
    await expect(error).toHaveText(en);
    await page.getByRole("button", { name: "Tiếng Việt", exact: true }).click();
    await expect(error).toHaveText(vi);
    await expect(page.getByRole("textbox", { name: "Họ tên", exact: true })).toHaveValue("QA Locale Guest");
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect(error).toHaveText(en);
    expect(requests).toBe(1);
  });
}

test("a delayed error uses the language selected while the request was pending", async ({ page }) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/booking-otp/send", async (route) => {
    requests++;
    await gate;
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"sms_suppressed"}' });
  });
  try {
    await page.getByRole("button", { name: "Send code", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sending…", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Tiếng Việt", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Đặt lịch tại tiệm", exact: true })).toBeVisible();
    release?.();
    await expect(page.getByTestId("booking-gate-otp-error")).toHaveText("Không gửi được SMS. Vui lòng thử lại.");
    expect(requests).toBe(1);
  } finally { release?.(); }
});
