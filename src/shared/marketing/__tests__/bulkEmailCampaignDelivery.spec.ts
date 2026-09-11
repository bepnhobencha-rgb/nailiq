import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ serviceRole: vi.fn(), resend: vi.fn() }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.serviceRole }));
vi.mock("@/shared/lib/resend", () => ({ getResendClient: mocks.resend, getResendFrom: () => "NailIQ <hello@nailiq.ca>" }));
import { bulkEmailDeliveryMode, runBulkEmailCampaignBatch } from "../bulkEmailCampaignDelivery";

describe("bulk email delivery gates", () => {
  it("is disabled by default in every environment", () => {
    expect(bulkEmailDeliveryMode({ VERCEL_ENV: "preview" })).toBe("disabled");
    expect(bulkEmailDeliveryMode({ VERCEL_ENV: "production", BULK_EMAIL_CAMPAIGN_PROVIDER: "resend" })).toBe("disabled");
  });

  it("returns before database or provider access while disabled", async () => {
    const result = await runBulkEmailCampaignBatch("00000000-0000-4000-8000-000000000000", 25, {
      VERCEL_ENV: "preview",
      BULK_EMAIL_CAMPAIGN_PROVIDER: "resend",
    });
    expect(result).toEqual({ mode: "disabled", claimed: 0, simulated: 0, providerAccepted: 0, suppressed: 0, failed: 0, unknown: 0 });
    expect(mocks.serviceRole).not.toHaveBeenCalled();
    expect(mocks.resend).not.toHaveBeenCalled();
  });

  it("never permits a real provider from Preview", () => {
    expect(bulkEmailDeliveryMode({
      VERCEL_ENV: "preview",
      BULK_EMAIL_CAMPAIGN_DISPATCH_ENABLED: "true",
      BULK_EMAIL_CAMPAIGN_PROVIDER: "resend",
      BULK_EMAIL_CAMPAIGN_QA_SIMULATION_ENABLED: "true",
    })).toBe("disabled");
  });

  it("requires an explicit QA simulation gate", () => {
    expect(bulkEmailDeliveryMode({
      VERCEL_ENV: "preview",
      BULK_EMAIL_CAMPAIGN_DISPATCH_ENABLED: "true",
      BULK_EMAIL_CAMPAIGN_PROVIDER: "mock",
      BULK_EMAIL_CAMPAIGN_QA_SIMULATION_ENABLED: "true",
    })).toBe("simulate");
  });

  it("requires both explicit Production dispatch and Resend provider", () => {
    expect(bulkEmailDeliveryMode({
      VERCEL_ENV: "production",
      BULK_EMAIL_CAMPAIGN_DISPATCH_ENABLED: "true",
      BULK_EMAIL_CAMPAIGN_PROVIDER: "resend",
    })).toBe("resend");
  });

  it("records QA simulation receipts without touching the provider", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: [{
          recipient_id: "00000000-0000-4000-8000-000000000001",
          ["attempt" + "_token"]: "00000000-0000-4000-8000-000000000002",
          idempotency_key: "bulk-email-test-recipient-0001",
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          code: "authorized",
          destination_email: "synthetic@example.invalid",
          client_name: "Synthetic Customer",
          salon_name: "Synthetic Salon",
          subject: "Synthetic subject",
          headline: "Synthetic headline",
          body: "Synthetic body",
          cta_label: "Book now",
          cta_url: "https://example.invalid/book",
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: { success: true, code: "simulated" }, error: null });
    mocks.serviceRole.mockReturnValue({ rpc });

    const result = await runBulkEmailCampaignBatch(
      "00000000-0000-4000-8000-000000000000",
      25,
      {
        VERCEL_ENV: "preview",
        BULK_EMAIL_CAMPAIGN_DISPATCH_ENABLED: "true",
        BULK_EMAIL_CAMPAIGN_PROVIDER: "mock",
        BULK_EMAIL_CAMPAIGN_QA_SIMULATION_ENABLED: "true",
      },
    );

    expect(result).toEqual({
      mode: "simulate",
      claimed: 1,
      simulated: 1,
      providerAccepted: 0,
      suppressed: 0,
      failed: 0,
      unknown: 0,
    });
    expect(mocks.resend).not.toHaveBeenCalled();
  });
});
