import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ optOut: vi.fn(), send: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: () => ({ emails: { send: mocks.send } }),
  getResendFrom: () => "NailIQ QA <qa@example.invalid>",
}));
vi.mock("@/shared/lib/emailCompliance", () => ({
  optionalEmailOptOutStatus: mocks.optOut,
  complianceFooterHtml: () => "",
  listUnsubscribeHeaders: () => ({}),
}));

import { sendGroupReminderEmail, sendReminderEmail } from "@/shared/noshow/sendReminderEmail";

const input = {
  salonId: "11111111-1111-4111-8111-111111111111",
  confirmToken: "synthetic-confirm",
  rescheduleToken: "qa-reschedule",
  cancelToken: "synthetic-cancel",
  clientName: "QA",
  clientEmail: "qa@example.invalid",
  serviceName: "QA service",
  staffName: "QA staff",
  startTimeUtc: "2026-09-30T18:00:00Z",
  salonName: "QA salon",
  salonSlug: "qa-salon",
  deterministicCopy: true,
};

describe("optional reminder email opt-out lookup (provider mocked)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    mocks.send.mockResolvedValue({ data: { id: "synthetic-receipt" }, error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["individual", "group"] as const)("keeps %s reminder retryable when opt-out lookup is unavailable", async (kind) => {
    mocks.optOut.mockResolvedValue("lookup_unavailable");
    const result = kind === "individual"
      ? await sendReminderEmail(input)
      : await sendGroupReminderEmail({ ...input, organizerName: "QA", organizerEmail: input.clientEmail,
        reminderType: "24h", members: [] });
    expect(result).toEqual({ ok: false, error: "email_opt_out_lookup_unavailable" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(["individual", "group"] as const)("records confirmed %s opt-out as suppressed without provider", async (kind) => {
    mocks.optOut.mockResolvedValue("suppressed");
    const result = kind === "individual"
      ? await sendReminderEmail(input)
      : await sendGroupReminderEmail({ ...input, organizerName: "QA", organizerEmail: input.clientEmail,
        reminderType: "24h", members: [] });
    expect(result).toMatchObject({ ok: true, suppressed: true, suppressionReason: "email_opt_out" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
