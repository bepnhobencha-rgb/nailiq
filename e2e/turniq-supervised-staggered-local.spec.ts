import { expect, test } from "@playwright/test";

const PATH = "/e2e-local/turniq-supervised-staggered";

test.describe("TurnIQ M4I supervised staggered local story", () => {
  test("compare, choose, review and atomically confirm", async ({ page }) => {
    await page.goto(`${PATH}?scenario=happy`);
    await expect(page.getByText("Synthetic TurnIQ M4I")).toBeVisible();

    await page.getByRole("button", { name: "So sánh 3 cách" }).click();
    await expect(page.getByText("Đến cùng lúc")).toBeVisible();
    await expect(page.getByText("Về cùng lúc")).toBeVisible();
    const wave = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Chia đợt thông minh" }),
    });
    await expect(wave.getByText("Chờ tối đa: 15′")).toBeVisible();
    await wave.getByRole("button", { name: "Chọn kế hoạch này" }).click();

    await expect(
      page.getByText(/Đã khóa kế hoạch cho 2 khách để kiểm tra/),
    ).toBeVisible();
    await expect(page.getByText("Kế hoạch đề xuất")).toBeVisible();
    await expect(page.getByText(/Nếu một khách xung đột, không booking nào bị đổi/)).toBeVisible();
    const review = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Kế hoạch đề xuất" }),
    });
    await expect(review.getByText("Mai")).toBeVisible();
    await expect(review.getByText("Linh")).toBeVisible();

    await page
      .getByRole("button", { name: "Áp dụng và xác nhận cả 2 khách" })
      .click();
    await expect(page.getByText("Nhóm đã được xác nhận")).toBeVisible();
    await expect(page.getByText("2 Fairness Receipt đã lưu")).toBeVisible();
  });

  test("stale comparison fails closed before review", async ({ page }) => {
    await page.goto(`${PATH}?scenario=stale`);
    await page.getByRole("button", { name: "So sánh 3 cách" }).click();
    const wave = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Chia đợt thông minh" }),
    });
    await wave.getByRole("button", { name: "Chọn kế hoạch này" }).click();
    await expect(page.getByText(/Không booking nào bị đổi; hãy so sánh lại/)).toBeVisible();
    await expect(page.getByText("Kế hoạch đề xuất")).toHaveCount(0);
  });

  test("committed plan success survives read-back failure", async ({ page }) => {
    await page.goto(`${PATH}?scenario=refresh_failure`);
    await page.getByRole("button", { name: "So sánh 3 cách" }).click();
    const wave = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Chia đợt thông minh" }),
    });
    await wave.getByRole("button", { name: "Chọn kế hoạch này" }).click();
    await expect(
      page.getByText(/Đã khóa kế hoạch cho 2 khách để kiểm tra/),
    ).toBeVisible();
    await expect(page.getByText(/thử lại sẽ dùng đúng yêu cầu cũ/i)).toHaveCount(0);
  });

  test("offline keeps the party visible and disables every mutation", async ({ page }) => {
    await page.goto(`${PATH}?scenario=offline`);
    await expect(page.getByText("Đang mất kết nối")).toBeVisible();
    await expect(page.getByText("Classic Pedicure")).toBeVisible();
    await expect(page.getByRole("button", { name: "So sánh 3 cách" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Tạo kế hoạch an toàn" })).toBeDisabled();
  });
});
