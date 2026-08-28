import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  suppressReason: vi.fn(),
}));

vi.mock("@/shared/lib/twilioSms", () => ({
  smsSuppressReason: mocks.suppressReason,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => { throw new Error("use env fallback"); },
}));

import { sendVerification } from "@/shared/lib/twilioVerify";

const attemptId = "55555555-5555-4555-8555-555555555555";
const verificationSid = `VE${"a".repeat(32)}`;
const providerAttemptId = `VL${"b".repeat(32)}`;

describe("Twilio Verify booking OTP delivery truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.suppressReason.mockReturnValue(null);
    vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"c".repeat(32)}`);
    vi.stubEnv("TWILIO_AUTH_TOKEN", "test-auth-token");
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", `VA${"d".repeat(32)}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns provider correlation and sends only non-PII claim tags", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      sid: verificationSid,
      status: "pending",
      send_code_attempts: [{ channel: "SMS", attempt_sid: providerAttemptId }],
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendVerification("+16045550199", "QA Salon", {
      deliveryAttemptId: attemptId,
    })).resolves.toEqual({
      ok: true,
      verificationSid,
      providerAttemptId,
      providerStatus: "pending",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const params = new URLSearchParams(String(init.body));
    expect(params.get("Tags")).toBe(JSON.stringify({
      nailiq_flow: "booking_otp",
      nailiq_claim: attemptId,
    }));
    expect(params.get("Tags")).not.toContain("16045550199");
  });

  it("does not report success when a successful HTTP response lacks a Verify SID", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "pending",
      send_code_attempts: [],
    }), { status: 201 })));

    await expect(sendVerification("+16045550199", "QA Salon", {
      deliveryAttemptId: attemptId,
    })).resolves.toEqual({
      ok: false,
      error: "provider_response_unverified",
      verificationSid: undefined,
      providerAttemptId: undefined,
      providerStatus: "pending",
    });
  });

  it("reports suppression explicitly without reading credentials or calling Twilio", async () => {
    mocks.suppressReason.mockReturnValue("non_production");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendVerification("+16045550199", "QA Salon", {
      deliveryAttemptId: attemptId,
    })).resolves.toEqual({
      ok: true,
      suppressed: true,
      providerStatus: "suppressed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
