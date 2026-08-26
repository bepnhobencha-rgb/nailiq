import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ language: "en" as "en" | "vi" }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/shared/lib/useUserLanguage", () => ({
  useUserLanguage: () => ({ language: mocks.language }),
}));
vi.mock("@/shared/auth/salonOwnerAuth", () => ({
  requestSalonOwnerPasswordReset: vi.fn(),
  completeSalonOwnerPasswordReset: vi.fn(),
}));
vi.mock("@/shared/superadmin/superadminAuth", () => ({
  completeSuperadminPasswordReset: vi.fn(),
}));
vi.mock("@/shared/register/actions", () => ({ sendLoginOtp: vi.fn() }));

import { ForgotPasswordClient } from "./forgot-password/ForgotPasswordClient";
import { LoginPageClient } from "./LoginPageClient";
import { SalonOwnerResetPasswordForm } from "./reset-password/SalonOwnerResetPasswordForm";
import { SuperadminResetPasswordForm } from "@/app/superadmin/reset-password/SuperadminResetPasswordForm";

describe("password reset user-facing states", () => {
  beforeEach(() => {
    mocks.language = "en";
  });

  it("renders the exact invalid-link state in English and Vietnamese", () => {
    const english = renderToStaticMarkup(
      createElement(ForgotPasswordClient, { invalidOrExpired: true }),
    );
    expect(english).toContain("This reset link has expired");

    mocks.language = "vi";
    const vietnamese = renderToStaticMarkup(
      createElement(ForgotPasswordClient, { invalidOrExpired: true }),
    );
    expect(vietnamese).toContain("Link đặt lại này đã hết hạn");
  });

  it("shows localized committed-success truth even when sign-in is disabled", () => {
    mocks.language = "vi";
    const html = renderToStaticMarkup(
      createElement(LoginPageClient, {
        demoMode: false,
        smsEnabled: false,
        emailEnabled: false,
        showPasswordResetNotice: true,
      }),
    );
    expect(html).toContain("Mật khẩu đã được đặt lại thành công");
    expect(html).toContain("salon-owner-password-reset-banner");
  });

  it("uses the same bounded 8-72 policy in both reset forms", () => {
    const salon = renderToStaticMarkup(
      createElement(SalonOwnerResetPasswordForm),
    );
    const superadmin = renderToStaticMarkup(
      createElement(SuperadminResetPasswordForm),
    );
    expect(salon.match(/min[Ll]ength="8"/g)).toHaveLength(2);
    expect(salon.match(/max[Ll]ength="72"/g)).toHaveLength(2);
    expect(superadmin.match(/min[Ll]ength="8"/g)).toHaveLength(2);
    expect(superadmin.match(/max[Ll]ength="72"/g)).toHaveLength(2);
    expect(superadmin).toContain("Mật khẩu mới");
  });
});
