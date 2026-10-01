import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), consent: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/booking/validateGuestPhone", () => ({
  validateGuestPhone: () => ({ ok: true, digits: "19990000001" }),
}));
vi.mock("@/shared/lib/phoneRegion", () => ({ isUsPhone: () => false }));
vi.mock("@/shared/lib/smsDeliveryTruth", () => ({
  claimSmsDeliveryAttempt: async () => ({
    attemptId: "synthetic-attempt", attemptToken: "synthetic-token",
  }),
  completeSmsDeliveryAttempt: mocks.complete,
  bindSmsAttemptToStatusCallback: () => "https://example.invalid/callback",
}));
vi.mock("@/shared/reminders/smsConsentSuppression", () => ({
  loadSmsOutboundSuppression: mocks.consent,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      const builder = {
        select: vi.fn(), eq: vi.fn(),
        maybeSingle: async () => {
          if (table === "platform_settings") return { error: null, data: {
            twilio_account_sid: "synthetic-account",
            twilio_auth_token: "synthetic-auth-token",
            twilio_phone_number: "+19990000000",
          } };
          if (table === "salons") return { error: null, data: {
            sms_outbound_enabled: true, sms_a2p_registered: true,
          } };
          if (table === "salon_sms_template_settings") return { error: null, data: null };
          throw new Error("Unexpected mocked table");
        },
      };
      builder.select.mockReturnValue(builder);
      builder.eq.mockReturnValue(builder);
      return builder;
    },
  }),
}));

import { sendSmsReminder } from "@/shared/lib/twilioSms";

const recipient = "+19990000001";
const body = "SYNTHETIC_PRIVATE_SMS_BODY";
const canary = "SYNTHETIC_PROVIDER_PRIVATE_CANARY";
const messageSid = `SM${"a".repeat(32)}`;
const opts = { salonId: "synthetic-salon", notificationType: "reminder_3h" };

describe("SMS provider error privacy and delivery truth (all I/O mocked)", () => {
  let network: ReturnType<typeof vi.fn>;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    // Install a fail-closed fake transport before simulating production guards.
    // These tests never access provider credentials, Supabase or real network.
    network = vi.fn(() => { throw new Error("Unexpected real network forbidden"); });
    vi.stubGlobal("fetch", network);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DISABLE_OUTBOUND_SMS", "0");
    vi.stubEnv("DEMO_OTP", "false");
    vi.stubEnv("NEXT_PUBLIC_DEMO_OTP", "false");
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.complete.mockResolvedValue(true);
    mocks.consent.mockResolvedValue({ suppressed: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function expectSafeLogs() {
    const logged = errorLog.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
    // Assert booleans so a failure report cannot itself print the captured body.
    for (const secret of [canary, recipient, body, "synthetic-auth-token", "synthetic-account", "example.invalid"]) {
      expect(logged.includes(secret), "provider diagnostics must exclude private context").toBe(false);
    }
  }

  it.each([400, 401, 429, 500, 503])("logs only the status code for HTTP %i without consuming the body", async (status) => {
    const text = vi.fn(async () => `${canary} ${recipient} ${body} synthetic-auth-token`);
    network.mockResolvedValue({ ok: false, status, text });

    const outcome = status >= 500 ? "unknown" : "rejected";
    expect(await sendSmsReminder(recipient, body, opts)).toMatchObject({
      ok: false, outcome, error: `twilio_${status}`, deliveryTruthPersisted: true,
    });
    expectSafeLogs();
    expect(errorLog).toHaveBeenCalledWith("[sendSmsReminder] Twilio error", status);
    expect(text).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: status >= 500 ? "unknown" : "failed", errorCode: `twilio_${status}`,
    }));
  });

  it("does not replace a known HTTP rejection with an exception when the error body cannot be read", async () => {
    const text = vi.fn(async () => { throw new Error(canary); });
    network.mockResolvedValue({ ok: false, status: 400, text });
    expect(await sendSmsReminder(recipient, body, opts)).toMatchObject({
      outcome: "rejected", error: "twilio_400",
    });
    expect(text).not.toHaveBeenCalled();
    expectSafeLogs();
  });

  it.each(["transport", "parse"])("keeps %s exceptions private and outcome unknown", async (stage) => {
    const privateError = new Error(`${canary} ${recipient} ${body} synthetic-auth-token`);
    if (stage === "transport") network.mockRejectedValue(privateError);
    else network.mockResolvedValue({ ok: true, json: async () => { throw privateError; } });

    expect(await sendSmsReminder(recipient, body, opts)).toMatchObject({
      ok: false, outcome: "unknown", error: "provider_exception", deliveryTruthPersisted: true,
    });
    expectSafeLogs();
    expect(errorLog).toHaveBeenCalledExactlyOnceWith("[sendSmsReminder] provider_exception");
    expect(network).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: "unknown", errorCode: "provider_exception",
    }));
  });

  it("does not log or accept a malformed provider receipt", async () => {
    network.mockResolvedValue({ ok: true, json: async () => ({ sid: canary }) });
    expect(await sendSmsReminder(recipient, body, opts)).toMatchObject({
      ok: false, outcome: "unknown", error: "invalid_provider_receipt",
    });
    expect(errorLog).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: "unknown", errorCode: "invalid_provider_receipt",
    }));
  });

  it.each([true, false])("retains provider acceptance and exact ledger persistence truth (%s)", async (persisted) => {
    network.mockResolvedValue({ ok: true, json: async () => ({ sid: messageSid }) });
    mocks.complete.mockResolvedValue(persisted);
    expect(await sendSmsReminder(recipient, body, opts)).toMatchObject({
      ok: true, outcome: "accepted", messageSid, deliveryTruthPersisted: persisted,
    });
    expect(errorLog).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: "accepted", providerMessageSid: messageSid,
    }));
  });

  it("still suppresses at the kill switch before reaching even the fake provider", async () => {
    vi.stubEnv("DISABLE_OUTBOUND_SMS", "1");
    expect(await sendSmsReminder(recipient, body, opts)).toMatchObject({
      ok: false, outcome: "suppressed", deliveryTruthPersisted: true,
    });
    expect(network).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "suppressed" }));
  });

  it("honors STOP before reaching the fake provider", async () => {
    mocks.consent.mockResolvedValue({ suppressed: true, reason: "provider_opt_out" });
    expect(await sendSmsReminder(recipient, body, opts)).toMatchObject({
      ok: false, outcome: "suppressed", suppressionReason: "provider_opt_out",
    });
    expect(network).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });
});
