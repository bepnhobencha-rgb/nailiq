import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getResendClient: vi.fn(),
  settings: {
    enabled: true,
    digest_emails: ["Owner@Example.com", "owner@example.com"],
  } as Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/shared/lib/resend", () => ({
  getResendClient: mocks.getResendClient,
  getResendFrom: () => "NailIQ <noreply@nailiq.ca>",
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table !== "salons") {
        throw new Error(`Unexpected table: ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { owner_notification_settings: mocks.settings },
            }),
          }),
        }),
      };
    },
  }),
}));

import {
  deterministicDigestBody,
  isDigestGrounded,
  sendDigestEmail,
} from "@/shared/ai/agentDigest";

describe("daily digest delivery truth", () => {
  beforeEach(() => {
    mocks.send.mockReset();
    mocks.getResendClient.mockReset();
    mocks.settings = {
      enabled: true,
      digest_emails: ["Owner@Example.com", "owner@example.com"],
    };
    mocks.getResendClient.mockReturnValue({
      emails: { send: mocks.send },
    });
  });

  it("rejects claims that a social draft was published", () => {
    expect(
      isDigestGrounded(
        "Tôi cũng đã xuất bản một nội dung trên mạng xã hội cho tiệm.",
        { hasSocialDraft: true, noShowCount: 0 },
      ),
    ).toBe(false);

    expect(
      isDigestGrounded(
        "Tôi đã soạn caption nháp và gửi riêng cho chủ tiệm để duyệt hoặc tự đăng.",
        { hasSocialDraft: true, noShowCount: 0 },
      ),
    ).toBe(true);
  });

  it("rejects self-attribution of a no-show status", () => {
    expect(
      isDigestGrounded(
        "Có 1 khách no-show hôm nay — tôi đã ghi nhận lại để theo dõi.",
        { hasSocialDraft: false, noShowCount: 1 },
      ),
    ).toBe(false);

    expect(
      isDigestGrounded(
        "Hệ thống ghi nhận 1 khách no-show do nhân viên đã đánh dấu.",
        { hasSocialDraft: false, noShowCount: 1 },
      ),
    ).toBe(true);
  });

  it("uses explicit truthful wording in the deterministic fallback", () => {
    const body = deterministicDigestBody(
      "Hi-Lite Head Spa",
      {
        total: 4,
        completed: 2,
        noShow: 1,
        cancelled: 0,
        revenueCents: 21_000,
        newClients: 0,
        tomorrowCount: 6,
      },
      0,
      { hasSocialDraft: true, noShowCount: 1 },
    );

    expect(body).toContain("Hệ thống ghi nhận 1 khách không đến");
    expect(body).toContain("caption nháp");
    expect(body).toContain("chưa đăng nội dung lên mạng xã hội");
    expect(isDigestGrounded(body, { hasSocialDraft: true, noShowCount: 1 })).toBe(true);
  });

  it("uses a stable provider idempotency key and returns acknowledged delivery", async () => {
    mocks.send.mockResolvedValue({
      data: { id: "resend-message-1" },
      error: null,
    });

    const result = await sendDigestEmail(
      "22222222-2222-4222-8222-222222222222",
      "Tech Nails",
      "A useful daily summary.",
      "2026-07-29",
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          summary: "Review the service menu",
          approve_token: "approve-token",
          decline_token: "decline-token",
        },
      ],
    );

    expect(result).toEqual({
      status: "sent",
      providerMessageId: "resend-message-1",
      recipientCount: 1,
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["owner@example.com"],
        html: expect.stringContaining("approve-token"),
      }),
      {
        idempotencyKey:
          "nailiq-digest-22222222-2222-4222-8222-222222222222-2026-07-29",
      },
    );
  });

  it("does not claim delivery when the provider rejects the email", async () => {
    mocks.send.mockResolvedValue({
      data: null,
      error: { message: "provider unavailable" },
    });

    await expect(
      sendDigestEmail(
        "22222222-2222-4222-8222-222222222222",
        "Tech Nails",
        "A useful daily summary.",
        "2026-07-29",
      ),
    ).resolves.toEqual({
      status: "failed",
      reason: "send_failed",
    });
  });

  it("treats a disabled notification channel as an intentional no-op", async () => {
    mocks.settings = { enabled: false };

    await expect(
      sendDigestEmail(
        "22222222-2222-4222-8222-222222222222",
        "Tech Nails",
        "A useful daily summary.",
        "2026-07-29",
      ),
    ).resolves.toEqual({
      status: "skipped",
      reason: "notifications_disabled",
    });
    expect(mocks.getResendClient).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
