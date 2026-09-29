import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getUserMessages } from "@/shared/i18n/user";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("signup confirmation experience boundary", () => {
  const registerPage = read("src/app/register/RegisterPageClient.tsx");
  const authControls = read("src/components/auth/SocialAuthButtons.tsx");
  const english = read("src/shared/i18n/user/en.ts");
  const vietnamese = read("src/shared/i18n/user/vi.ts");

  it("shows the trial promise once on the register entry page", () => {
    expect(registerPage).toContain("subtext={t.signInOrSignUpSubtext}");
    expect(registerPage).not.toContain("helperHint={t.registerMicrotrust}");
  });

  it("describes guided setup without promising an unproven two-minute launch", () => {
    const en = getUserMessages("en");
    const vi = getUserMessages("vi");

    expect(en.auth.brandBullet2).toBe(
      "Create your account, then set up your salon step by step",
    );
    expect(vi.auth.brandBullet2).toBe(
      "Tạo tài khoản, rồi thiết lập salon từng bước",
    );
    for (const messages of [en, vi]) {
      expect(
        [
          messages.home.ctaSpeed,
          messages.landing.hero.microtrust,
          messages.auth.signInOrSignUpSubtext,
          messages.auth.brandBullet2,
        ].join(" "),
      ).not.toMatch(/2 minutes|2 phút/i);
    }
  });

  it("distinguishes a send request from a delivered email", () => {
    expect(english).toContain("the request to send a confirmation link");
    expect(vietnamese).toContain("yêu cầu gửi link xác nhận");
    expect(english).not.toContain(
      'signUpConfirmEmailBody:\n      "We sent a confirmation link',
    );
    expect(vietnamese).not.toContain(
      'signUpConfirmEmailBody:\n      "Chúng tôi đã gửi link xác nhận',
    );
  });

  it("keeps synthetic QA truth and resend controls explicit", () => {
    expect(authControls).toContain('"synthetic_no_delivery"');
    expect(authControls).toContain("resendSignupConfirmationEmail");
    expect(authControls).toContain("t.signUpDeliveryHelp");
    expect(authControls).toContain("t.signUpResendCountdown");
  });
});
