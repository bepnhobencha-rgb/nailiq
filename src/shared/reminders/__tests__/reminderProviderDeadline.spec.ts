import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(), suppression: vi.fn(), complete: vi.fn(), lookup: vi.fn(), ai: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/resend", () => ({ getResendClient: () => ({ emails: { send: mocks.send } }), getResendFrom: () => "QA <qa@example.invalid>" }));
vi.mock("@/shared/lib/emailCompliance", () => ({ isEmailSuppressed: mocks.suppression, complianceFooterHtml: () => "", listUnsubscribeHeaders: () => ({}) }));
vi.mock("@/shared/ai/anthropicProviderPolicy", () => ({ createTextBackgroundAnthropicClient: mocks.ai }));
vi.mock("@/shared/ai/usageLedger", () => ({ isProviderTimeoutError: () => false, trackAnthropicMessage: mocks.ai }));
vi.mock("@/shared/booking/validateGuestPhone", () => ({ validateGuestPhone: () => ({ ok: true, digits: "19990000001" }) }));
vi.mock("@/shared/lib/phoneRegion", () => ({ isUsPhone: () => false }));
vi.mock("@/shared/lib/smsDeliveryTruth", () => ({
  claimSmsDeliveryAttempt: async () => ({ attemptId: "synthetic-attempt", attemptToken: "synthetic-token" }),
  completeSmsDeliveryAttempt: mocks.complete,
  bindSmsAttemptToStatusCallback: () => "https://example.invalid/callback",
}));
vi.mock("@/shared/reminders/smsConsentSuppression", () => ({ loadSmsOutboundSuppression: async () => ({ suppressed: false }) }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => ({
  from: (table: string) => {
    const builder = { select: vi.fn(), eq: vi.fn(), maybeSingle: () => mocks.lookup(table) };
    builder.select.mockReturnValue(builder); builder.eq.mockReturnValue(builder); return builder;
  },
}) }));

import { sendReminderEmail, sendGroupReminderEmail } from "@/shared/noshow/sendReminderEmail";
import { sendSmsReminder } from "@/shared/lib/twilioSms";

const input = {
  salonId: "synthetic-salon", confirmToken: "synthetic-confirm", rescheduleToken: "synthetic-move",
  cancelToken: "synthetic-cancel", clientName: "QA", clientEmail: "qa@example.invalid", serviceName: "QA service",
  staffName: "QA staff", startTimeUtc: "2026-09-25T03:00:00Z", salonName: "QA salon", salonSlug: "e2e-deadline",
  sendBeforeUtc: "2026-09-25T01:00:00Z", deterministicCopy: true,
};

describe("deadline at the actual provider boundary (providers mocked)", () => {
  let network: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-25T00:59:59Z"));
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("DISABLE_OUTBOUND_SMS", "0");
    vi.stubEnv("DEMO_OTP", "false"); vi.stubEnv("NEXT_PUBLIC_DEMO_OTP", "false");
    network = vi.fn(() => { throw new Error("Real network forbidden"); }); vi.stubGlobal("fetch", network);
    mocks.complete.mockResolvedValue(true);
    mocks.suppression.mockImplementation(async () => { vi.setSystemTime(new Date("2026-09-25T01:00:00.001Z")); return false; });
    mocks.lookup.mockImplementation(async (table: string) => {
      if (table === "platform_settings") vi.setSystemTime(new Date("2026-09-25T01:00:00.001Z"));
      return { data: { sms_outbound_enabled: true, sms_a2p_registered: true,
        twilio_account_sid: "synthetic", twilio_auth_token: "synthetic", twilio_phone_number: "+19990000000" }, error: null };
    });
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled(); expect(mocks.ai).not.toHaveBeenCalled();
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  });
  it("blocks individual email after a slow suppression lookup", async () => {
    expect(await sendReminderEmail(input)).toEqual({ ok: false, error: "recovery_window_expired" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("blocks group email after a slow suppression lookup", async () => {
    expect(await sendGroupReminderEmail({ ...input, organizerName: "QA", organizerEmail: "qa@example.invalid", reminderType: "3h", members: [] }))
      .toEqual({ ok: false, error: "recovery_window_expired" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("blocks SMS after credential/policy preparation without fetching Twilio", async () => {
    expect(await sendSmsReminder("synthetic-recipient", "Synthetic body", {
      salonId: "synthetic-salon", notificationType: "reminder_3h", sendBeforeUtc: input.sendBeforeUtc,
    })).toMatchObject({ ok: false, outcome: "rejected", error: "recovery_window_expired" });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorCode: "recovery_window_expired" }));
  });
});
