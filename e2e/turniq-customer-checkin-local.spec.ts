import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PATH = "/e2e-local/turniq-customer-checkin";

test.describe("TurnIQ M4L customer check-in local story", () => {
  test("booked single check-in stays shadow-only and prepares engine review", async ({ page }) => {
    await page.goto(`${PATH}?scenario=booked`);
    await expect(page.getByText("Synthetic TurnIQ M4L")).toBeVisible();
    await page.getByRole("button", { name: /Check in safely/ }).click();
    await expect(page.getByText("Check-in received / Đã nhận check-in", { exact: true })).toBeVisible();
    await expect(page.getByText(/next eligible technician/)).toBeVisible();
    await expect(page.getByText(/no booking or assignment changed/i)).toBeVisible();
  });

  test("a party is routed to whole-group optimization", async ({ page }) => {
    await page.goto(`${PATH}?scenario=group`);
    await expect(page.getByRole("status", { name: "Party size" })).toHaveText("4");
    await page.getByRole("button", { name: /Check in safely/ }).click();
    await expect(page.getByText(/whole party together/)).toBeVisible();
  });

  test("a direct technician selection retains customer-request truth", async ({ page }) => {
    await page.goto(`${PATH}?scenario=requested`);
    await expect(page.getByLabel(/Requested technician/)).toHaveValue(
      "22222222-2222-4222-8222-222222222222",
    );
    await page.getByRole("button", { name: /Check in safely/ }).click();
    await expect(page.getByText(/technician request was recorded/)).toBeVisible();
  });

  test("a walk-in is not silently converted into a booking", async ({ page }) => {
    await page.goto(`${PATH}?scenario=walkin`);
    await page.getByRole("button", { name: /Check in safely/ }).click();
    await expect(page.getByText(/match this walk-in before any booking is created/)).toBeVisible();
  });

  test("offline is truthful and blocks submission", async ({ page }) => {
    await page.goto(`${PATH}?scenario=offline`);
    await expect(page.getByText(/Check-in is unavailable offline/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Check in safely/ })).toBeDisabled();
    await expect(page.getByText("Check-in received / Đã nhận check-in", { exact: true })).toHaveCount(0);
  });

  test("capability flow retries the exact command and remains shadow-only", async ({ page }) => {
    const payloads: Array<Record<string, unknown>> = [];
    await page.route("**/api/turniq/customer-checkin", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      payloads.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          replayed: payloads.length > 1,
          status: "shadow_received",
          nextRoute: "single_engine_candidate",
          intakeFingerprint: "b".repeat(64),
          message: {
            en: "Check-in received for a safe availability review. No appointment has changed yet.",
            vi: "Đã nhận check-in để kiểm tra chỗ an toàn. Chưa có lịch hẹn nào bị thay đổi.",
          },
        }),
      });
    });
    await page.goto(`${PATH}?scenario=server`);
    await page.getByRole("button", { name: /Check in safely/ }).click();
    await expect(page.getByText("Check-in received / Đã nhận check-in", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Check again safely/ }).click();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]?.commandId).toBe(payloads[0]?.commandId);
    expect(payloads[1]?.submittedAt).toBe(payloads[0]?.submittedAt);
    expect(JSON.stringify(payloads[0])).not.toMatch(/customerName|phone|email|bookingId/i);
    await expect(page.getByText(/no booking or assignment changed/i)).toBeVisible();
  });

  test("expired capability is explained without implying a booking change", async ({ page }) => {
    await page.route("**/api/turniq/customer-checkin", (route) => route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "capability_unavailable" }),
    }));
    await page.goto(`${PATH}?scenario=server`);
    await page.getByRole("button", { name: /Check in safely/ }).click();
    await expect(page.getByText(/QR đã hết hạn/)).toBeVisible();
    await expect(page.getByText("Check-in received / Đã nhận check-in", { exact: true })).toHaveCount(0);
  });

  test("live network loss blocks submission and recovers when online", async ({ page, context }) => {
    await page.goto(`${PATH}?scenario=server`);
    await context.setOffline(true);
    await expect(page.getByText(/Không thể check-in khi mất mạng/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Check in safely/ })).toBeDisabled();
    await context.setOffline(false);
    await expect(page.getByRole("button", { name: /Check in safely/ })).toBeEnabled();
  });

  test("customer check-in has no automatic accessibility violations", async ({ page }) => {
    await page.goto(`${PATH}?scenario=booked`);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
