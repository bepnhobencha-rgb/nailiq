import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams("slug=mai-nails&adjusted=0"),
}));
vi.mock("@/shared/lib/useUserLanguage", () => ({
  useUserLanguage: () => ({ language: "vi" as const }),
}));
vi.mock("@/shared/register/completeSalonRegistrationAction", () => ({
  completeSalonRegistration: vi.fn(),
}));

import RegisterSetupInner from "@/app/register/setup/RegisterSetupInner";
import RegisterSuccessPage from "@/app/register/success/page";

describe("registration onboarding experience", () => {
  it("shows a private safe-start promise and keeps advanced settings optional", () => {
    const html = renderToStaticMarkup(
      createElement(RegisterSetupInner, { isDemoMode: false }),
    );

    expect(html).toContain('data-testid="registration-safe-start"');
    expect(html).toContain("Giữ riêng tư đến khi Owner duyệt Go-Live");
    expect(html).toContain("không mở booking");
    expect(html).toContain("không nhắn khách");
    expect(html).toContain("không thu tiền");
    expect(html).toContain("Kiểm tra link booking và múi giờ");
    expect(html).toContain('id="register-setup-slug"');
    expect(html).toContain('id="register-setup-timezone"');
    expect(html).toContain("Tạo không gian salon");
  });

  it("states the exact non-live boundaries before Coco Setup", () => {
    const html = renderToStaticMarkup(createElement(RegisterSuccessPage));

    expect(html).toContain('data-testid="registration-launch-status"');
    expect(html).toContain("Salon của bạn chưa Live");
    expect(html).toContain("Trang booking công khai vẫn đóng");
    expect(html).toContain("Không gửi SMS hoặc email cho khách");
    expect(html).toContain("Chưa kết nối hoặc thu tiền qua provider");
    expect(html).toContain("Bắt đầu Coco Setup");
  });
});
