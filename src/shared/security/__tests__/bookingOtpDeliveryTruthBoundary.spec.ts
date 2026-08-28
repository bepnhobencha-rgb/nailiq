import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

describe("booking gate OTP delivery truth boundary", () => {
  const switcher = read("src/components/booking/BookingTypeSwitcher.tsx");
  const english = read("src/shared/i18n/booking/en.ts");
  const vietnamese = read("src/shared/i18n/booking/vi.ts");

  it("renders mutually exclusive email and SMS delivery receipts", () => {
    expect(switcher).toContain('channel === "email" ? (');
    expect(switcher).toContain('data-testid="booking-gate-otp-delivery-email"');
    expect(switcher).toContain("{t.otpEmailStepSubheading} {maskOtpEmail(email)}");
    expect(switcher).toContain('data-testid="booking-gate-otp-delivery-sms"');
    expect(switcher).not.toContain(
      'channel === "email" ? ` ${t.otpAndEmail ?? "& email"}` : ""',
    );
  });

  it("offers an explicit SMS request after an email-only send", () => {
    expect(switcher).toContain('data-testid="booking-gate-otp-sms-send"');
    expect(switcher).toContain('void sendCode("sms")');
    expect(english).toContain('otpSmsSendCta: "Send code by SMS"');
    expect(vietnamese).toContain('otpSmsSendCta: "Gửi mã qua SMS"');
    expect(english).toContain('otpEmailResendCta: "Resend by email"');
    expect(vietnamese).toContain('otpSmsResendCta: "Gửi lại qua SMS"');
  });

  it("reports channel-specific send failures", () => {
    expect(switcher).toContain("t.bookingErrors.otpEmailSendFailed");
    expect(english).toContain(
      'otpEmailSendFailed: "Couldn\'t send email. Please try again."',
    );
    expect(vietnamese).toContain(
      'otpEmailSendFailed: "Không gửi được email. Vui lòng thử lại."',
    );
  });
});
