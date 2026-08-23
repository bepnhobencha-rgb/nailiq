import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/shared/ai/anthropicProviderPolicy", () => ({
  createTextBackgroundAnthropicClient: () => ({
    messages: { create: mocks.create },
  }),
}));
vi.mock("@/shared/ai/usageLedger", () => ({
  trackAnthropicMessage: async (
    _context: unknown,
    execute: () => Promise<unknown>,
  ) => execute(),
  isProviderTimeoutError: (error: unknown) =>
    error instanceof Error && error.name === "APIConnectionTimeoutError",
}));
vi.mock("@/shared/lib/resend", () => ({
  getResendClient: () => ({ emails: { send: mocks.send } }),
  getResendFrom: () => "NailIQ QA <qa@example.test>",
}));
vi.mock("@/shared/lib/emailCompliance", () => ({
  complianceFooterHtml: () => "",
  listUnsubscribeHeaders: () => ({}),
  isEmailSuppressed: async () => false,
}));

import { sendReminderEmail } from "@/shared/noshow/sendReminderEmail";

describe("reminder email provider-timeout boundary", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "qa-key";
    mocks.create.mockReset();
    mocks.send.mockReset();
  });

  it("does not call Resend after the Anthropic attempt times out", async () => {
    const timeout = Object.assign(new Error("deadline exceeded"), {
      name: "APIConnectionTimeoutError",
    });
    mocks.create.mockRejectedValue(timeout);

    await expect(
      sendReminderEmail({
        salonId: "00000000-0000-4000-8000-000000000010",
        confirmToken: "confirm",
        rescheduleToken: "reschedule",
        cancelToken: "cancel",
        clientName: "QA Guest",
        clientEmail: "qa@example.test",
        serviceName: "QA Service",
        staffName: "QA Staff",
        startTimeUtc: "2026-08-23T19:00:00.000Z",
        salonName: "QA Salon",
        salonSlug: "qa-salon",
      }),
    ).rejects.toBe(timeout);

    expect(mocks.send).not.toHaveBeenCalled();
  });
});
