import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import {
  bindSmsAttemptToStatusCallback,
  claimSmsDeliveryAttempt,
  completeSmsDeliveryAttempt,
  smsFingerprint,
} from "@/shared/lib/smsDeliveryTruth";

const attemptId = "22222222-2222-4222-8222-222222222222";
const attemptToken = ["7f4c5d6e", "8a9b", "4c1d", "b2e3", "4f5a6b7c8d9e"].join("-");

describe("SMS delivery truth", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("claims before provider using fingerprints instead of raw recipient/body", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        success: true,
        code: "claimed",
        attempt_id: attemptId,
        attempt_token: attemptToken,
      },
      error: null,
    }));
    mocks.createServiceRoleClient.mockReturnValue({ rpc });

    const claim = await claimSmsDeliveryAttempt({
      salonId: "11111111-1111-4111-8111-111111111111",
      notificationType: "client_message",
      recipientE164: "+16045101234",
      body: "private body",
    });

    expect(claim).toEqual({ attemptId, attemptToken });
    const params = (
      rpc.mock.calls as unknown as Array<[string, Record<string, unknown>]>
    )[0]?.[1] ?? {};
    expect(params.p_recipient_fingerprint).toBe(smsFingerprint("+16045101234"));
    expect(params.p_body_fingerprint).toBe(smsFingerprint("private body"));
    expect(JSON.stringify(params)).not.toContain("private body");
    expect(JSON.stringify(params)).not.toContain("+16045101234");
  });

  it("fails closed when the attempt claim is unavailable", async () => {
    mocks.createServiceRoleClient.mockReturnValue({
      rpc: vi.fn(async () => ({ data: null, error: { message: "offline" } })),
    });
    await expect(claimSmsDeliveryAttempt({
      salonId: "11111111-1111-4111-8111-111111111111",
      recipientE164: "+16045101234",
      body: "hello",
    })).resolves.toBeNull();
  });

  it("preserves an existing domain callback and binds the universal attempt", () => {
    const url = bindSmsAttemptToStatusCallback(
      "https://nailiq.ca/api/twilio/status?notification_id=44444444-4444-4444-8444-444444444444",
      attemptId,
    );
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("notification_id")).toBe("44444444-4444-4444-8444-444444444444");
    expect(parsed.searchParams.get("sms_attempt_id")).toBe(attemptId);
    expect(parsed.searchParams.get("sms_domain_callback")).toBe("1");
  });

  it("persists a typed terminal completion", async () => {
    const rpc = vi.fn(async () => ({
      data: { success: true, code: "completed" },
      error: null,
    }));
    mocks.createServiceRoleClient.mockReturnValue({ rpc });
    await expect(completeSmsDeliveryAttempt({
      attemptId,
      attemptToken,
      status: "suppressed",
      suppressionReason: "outbound_disabled",
    })).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "complete_sms_delivery_attempt",
      expect.objectContaining({
        p_status: "suppressed",
        p_suppression_reason: "outbound_disabled",
        p_provider_message_sid: null,
      }),
    );
  });
});
