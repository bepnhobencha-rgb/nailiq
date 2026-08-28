import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

describe("booking gate OTP delivery truth boundary", () => {
  const switcher = read("src/components/booking/BookingTypeSwitcher.tsx");
  const english = read("src/shared/i18n/booking/en.ts");
  const vietnamese = read("src/shared/i18n/booking/vi.ts");
  const migration = read(
    "supabase/migrations/20260828172258_add_booking_otp_delivery_truth.sql",
  );
  const emailOtp = read("src/shared/lib/emailOtp.ts");
  const twilioVerify = read("src/shared/lib/twilioVerify.ts");
  const sendRoute = read("src/app/api/booking-otp/send/route.ts");
  const verifyRoute = read("src/app/api/booking-otp/verify/route.ts");
  const webhook = read("src/shared/notifications/resendOwnerDeliveryWebhook.ts");

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

  it("fails closed instead of reporting email success without Resend", () => {
    expect(emailOtp).not.toContain('sent.error !== "resend_not_configured"');
    expect(emailOtp).toContain('error: "resend_not_configured"');
    expect(emailOtp).toContain('deliveryStatus: "provider_accepted"');
    expect(emailOtp).toContain("idempotencyKey: `booking-otp/${input.deliveryAttemptId}`");
    expect(emailOtp).toContain('{ name: "nailiq_flow", value: "booking_otp" }');
    expect(emailOtp).toContain('process.env.NODE_ENV === "production" ? null');
  });

  it("claims durable truth before either booking OTP provider call", () => {
    expect(sendRoute).toContain("createBookingOtpDeliveryAttempt");
    expect(sendRoute.indexOf("createBookingOtpDeliveryAttempt")).toBeLessThan(
      sendRoute.indexOf("sendVerification(e164"),
    );
    expect(emailOtp.indexOf("createBookingOtpDeliveryAttempt")).toBeLessThan(
      emailOtp.indexOf("sendOtpCodeEmail"),
    );
    expect(twilioVerify).toContain('params.Tags = JSON.stringify({');
    expect(twilioVerify).toContain('nailiq_flow: "booking_otp"');
    expect(twilioVerify).toContain("send_code_attempts");
  });

  it("keeps the OTP ledger private and records direct customer verification", () => {
    for (const table of [
      "booking_otp_delivery_attempts",
      "resend_booking_otp_delivery_events",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toMatch(new RegExp(
        `REVOKE ALL PRIVILEGES ON TABLE public\\.${table}[\\s\\S]{0,120}service_role`,
      ));
    }
    const attemptTable = migration.slice(
      migration.indexOf("CREATE TABLE public.booking_otp_delivery_attempts"),
      migration.indexOf("CREATE UNIQUE INDEX booking_otp_delivery_provider_request_once"),
    );
    for (const forbiddenColumn of ["phone", "email", "otp_code", "message_body"]) {
      expect(attemptTable).not.toMatch(
        new RegExp(`\\n\\s+${forbiddenColumn}\\s+`, "i"),
      );
    }
    expect(verifyRoute).toContain("markBookingOtpDeliveryVerified");
    expect(migration).toContain("SET status = 'delivered'");
  });

  it("accepts only signed, tagged Resend OTP receipts", () => {
    expect(webhook).toContain('tags?.nailiq_flow !== "booking_otp"');
    expect(webhook).toContain("deliveryAttemptId: deliveryAttemptId.toLowerCase()");
    expect(migration).toContain("record_resend_booking_otp_delivery_event");
    expect(migration).toContain("event_conflict");
  });
});
