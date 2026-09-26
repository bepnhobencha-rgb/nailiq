import { expect, test } from "@playwright/test";

const SYNTHETIC_TOKEN = "11111111-1111-4111-8111-111111111111";
const SYNTHETIC_CANCEL_TOKEN = "22222222-2222-4222-8222-222222222222";

// API mocked: UI regression only, no database, notifications, or provider calls.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: { ok: false } }));
});

for (const action of ["confirm", "cancel"] as const) {
  for (const [code, title] of [["token_consumed", "Link already used"], ["stale_booking", "Appointment details have changed"], ["expired_or_revoked", "Link no longer available"]]) {
    test(`${action}: ${code} gives safe guidance`, async ({ page }) => {
      await page.route(`**/api/booking/${action}-action?**`, route => route.fulfill({ status: 410, json: { ok: false, code } }));
      await page.goto(`/booking/${action}?${new URLSearchParams({ token: SYNTHETIC_TOKEN })}`);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.getByRole("status")).toContainText("tiệm");
      await expect(page.getByRole("button")).toHaveCount(0);
    });
  }
}

test("cancel shows authorized appointment in salon time before explicit submission", async ({ page }, testInfo) => {
  let posts = 0;
  await page.route("**/api/booking/cancel-action**", async route => {
    if (route.request().method() === "POST") {
      posts++;
      await route.fulfill({ json: { ok: true, bookingCommitted: true, feeCharged: false, feeStatus: "not_applicable" } });
      return;
    }
    await route.fulfill({ json: { ok: true, startPast: false, willCharge: false, booking: {
      salonName: "QA Salon", serviceName: "QA Classic", startTimeUtc: "2026-09-29T20:00:00Z", salonTimezone: "America/Vancouver",
    } } });
  });
  await page.goto(`/booking/cancel?${new URLSearchParams({ token: SYNTHETIC_CANCEL_TOKEN })}`);
  await expect(page.getByText("QA Salon", { exact: true })).toBeVisible();
  await expect(page.getByText("QA Classic", { exact: true })).toBeVisible();
  await expect(page.getByText(/Tuesday, September 29.*1:00 PM PDT/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("cancel-summary-mobile.png"), fullPage: true });
  expect(posts).toBe(0);
  await page.getByRole("button", { name: "Yes, cancel my appointment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Appointment Cancelled", exact: true })).toBeVisible();
  expect(posts).toBe(1);
});
