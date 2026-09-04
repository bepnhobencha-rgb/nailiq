import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PATH = "/e2e-local/turniq-staff-pin";

test.describe("TurnIQ M3I staff PIN local browser story", () => {
  test("PIN stays private, rejects an incorrect PIN, and retries the same command", async ({
    page,
  }) => {
    await page.goto(PATH);
    const pin = page.getByLabel("Mã PIN thợ");

    await pin.fill("24ab68");
    await expect(pin).toHaveValue("2468");
    await page.getByRole("button", { name: "Đặt / đổi PIN" }).click();
    const actionStatus = page.getByRole("status").filter({
      hasText: "NailIQ chỉ lưu mã băm bảo mật",
    });
    await expect(actionStatus).toBeVisible();
    await expect(pin).toHaveValue("");

    await pin.fill("1111");
    await page.getByRole("button", { name: "Vào ca" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Mã PIN không đúng" }),
    ).toBeVisible();

    await pin.fill("2468");
    await page.getByRole("button", { name: "Vào ca" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Chưa thể hoàn tất" }),
    ).toBeVisible();
    await expect(page.getByTestId("turniq-pin-attempt-count")).toHaveText("2");

    await page.getByRole("button", { name: "Vào ca" }).click();
    await expect(
      page.getByRole("status").filter({
        hasText: "Vào ca đã được ghi nhận an toàn",
      }),
    ).toBeVisible();
    await expect(page.getByTestId("turniq-pin-attempt-count")).toHaveText("3");
    await expect(page.getByTestId("turniq-pin-retry-idempotent")).toHaveText(
      "same-command-id",
    );
    await expect(pin).toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Bắt đầu nghỉ" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Rời ca" })).toBeVisible();
  });

  test("staff PIN card has no automatic accessibility violations", async ({
    page,
  }) => {
    await page.goto(PATH);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("12 staff keep arrival order while an approved break freezes position", async ({
    page,
  }) => {
    await page.goto(PATH);
    const staffSelect = page.getByLabel("Chọn thợ");
    const pin = page.getByLabel("Mã PIN thợ");

    for (let index = 1; index <= 12; index += 1) {
      const staffName = `QA Tech ${String(index).padStart(2, "0")}`;
      await staffSelect.selectOption({ label: staffName });
      await pin.fill("2468");
      await page.getByRole("button", { name: "Vào ca" }).click();
      if (index === 1) {
        await expect(
          page.getByRole("status").filter({ hasText: "Chưa thể hoàn tất" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Vào ca" }).click();
      }
      await expect(
        page.getByRole("status").filter({
          hasText: `${staffName}: Vào ca đã được ghi nhận an toàn`,
        }),
      ).toBeVisible();
      await expect(
        page.getByTestId(`turniq-pin-staff-${String(index).padStart(2, "0")}`),
      ).toHaveAttribute("data-queue-position", String(index));
    }

    const orderedStaff = page
      .getByTestId("turniq-pin-queue-order")
      .getByRole("listitem");
    await expect(orderedStaff).toHaveCount(12);
    await expect(orderedStaff.first()).toContainText("1. QA Tech 01");
    await expect(orderedStaff.last()).toContainText("12. QA Tech 12");

    await staffSelect.selectOption({ label: "QA Tech 05" });
    await pin.fill("2468");
    await page.getByRole("button", { name: "Bắt đầu nghỉ" }).click();
    await expect(page.getByTestId("turniq-pin-staff-05")).toHaveAttribute(
      "data-state",
      "approved_break",
    );
    await expect(page.getByTestId("turniq-pin-staff-05")).toHaveAttribute(
      "data-queue-position",
      "5",
    );

    await pin.fill("2468");
    await page.getByRole("button", { name: "Quay lại" }).click();
    await expect(page.getByTestId("turniq-pin-staff-05")).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(page.getByTestId("turniq-pin-staff-05")).toHaveAttribute(
      "data-queue-position",
      "5",
    );
  });
});
