import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const attemptId = "55555555-5555-4555-8555-555555555555";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  createAttempt: vi.fn(),
  completeAttempt: vi.fn(),
  resendClient: null as null | { emails: { send: ReturnType<typeof vi.fn> } },
  getResendClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ from: mocks.from }),
}));
vi.mock("@/shared/booking/otpDeliveryTruth", () => ({
  createBookingOtpDeliveryAttempt: mocks.createAttempt,
  completeBookingOtpDeliveryAttempt: mocks.completeAttempt,
}));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: mocks.getResendClient,
  getResendFrom: () => "NailIQ <noreply@nailiq.test>",
}));

import { createAndSendEmailOtp } from "@/shared/lib/emailOtp";

function codeTable(rateError: unknown = null) {
  const rate = {
    eq: vi.fn(),
    gte: vi.fn().mockResolvedValue({ count: rateError ? null : 0, error: rateError }),
  };
  rate.eq.mockReturnValue(rate);
  const consumed = { eq: vi.fn().mockResolvedValue({ error: null }) };
  return {
    select: vi.fn(() => rate),
    insert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn(() => consumed),
    consumed,
  };
}

const args = {
  salonId: "11111111-1111-4111-8111-111111111111",
  phone: "16045550199",
  email: "Guest@Example.COM",
  salonName: "QA Salon",
};

describe("email booking OTP delivery truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("INTERNAL_API_SECRET", "local-otp-secret-for-tests");
    mocks.createAttempt.mockResolvedValue({
      ok: true,
      attemptId,
      recipientFingerprint: "a".repeat(64),
    });
    mocks.completeAttempt.mockResolvedValue(true);
    mocks.getResendClient.mockImplementation(() => mocks.resendClient);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("fails closed and consumes the code when Resend is not configured", async () => {
    const table = codeTable();
    mocks.from.mockReturnValue(table);
    mocks.resendClient = null;

    await expect(createAndSendEmailOtp(args)).resolves.toMatchObject({
      ok: false,
      error: "resend_not_configured",
      deliveryAttemptId: attemptId,
      deliveryStatus: "failed",
    });
    expect(mocks.completeAttempt).toHaveBeenCalledWith({
      attemptId,
      status: "failed",
      errorCode: "resend_not_configured",
    });
    expect(table.update).toHaveBeenCalledWith(expect.objectContaining({
      consumed_at: expect.any(String),
    }));
  });

  it("records provider acceptance with tags and an idempotency key", async () => {
    const table = codeTable();
    mocks.from.mockReturnValue(table);
    const send = vi.fn().mockResolvedValue({
      data: { id: "resend-otp-message-1" },
      error: null,
    });
    mocks.resendClient = { emails: { send } };

    await expect(createAndSendEmailOtp(args)).resolves.toEqual({
      ok: true,
      deliveryAttemptId: attemptId,
      deliveryStatus: "provider_accepted",
    });
    expect(table.insert).toHaveBeenCalledWith(expect.objectContaining({
      email: "guest@example.com",
      delivery_attempt_id: attemptId,
    }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "guest@example.com",
        tags: [
          { name: "nailiq_email", value: "booking_otp" },
          { name: "nailiq_audience", value: "security" },
          { name: "nailiq_flow", value: "booking_otp" },
          { name: "nailiq_claim", value: attemptId },
        ],
      }),
      { idempotencyKey: `booking-otp/${attemptId}` },
    );
    expect(mocks.completeAttempt).toHaveBeenLastCalledWith({
      attemptId,
      status: "provider_accepted",
      providerRequestId: "resend-otp-message-1",
    });
  });

  it("suppresses delivery before the Resend client can be reached", async () => {
    const table = codeTable();
    mocks.from.mockReturnValue(table);
    const send = vi.fn();
    mocks.resendClient = { emails: { send } };
    vi.stubEnv("DISABLE_OUTBOUND_EMAIL", "1");

    await expect(createAndSendEmailOtp(args)).resolves.toMatchObject({
      ok: false,
      error: "email_suppressed",
      deliveryAttemptId: attemptId,
      deliveryStatus: "suppressed",
    });
    expect(mocks.getResendClient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.completeAttempt).toHaveBeenCalledWith({
      attemptId,
      status: "suppressed",
      errorCode: "email_suppressed",
    });
    expect(table.update).toHaveBeenCalledWith(expect.objectContaining({
      consumed_at: expect.any(String),
    }));
  });

  it("fails closed when the durable rate-limit lookup is unavailable", async () => {
    mocks.from.mockReturnValue(codeTable({ code: "database_down" }));
    await expect(createAndSendEmailOtp(args)).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.createAttempt).not.toHaveBeenCalled();
    expect(mocks.getResendClient).not.toHaveBeenCalled();
  });
});
