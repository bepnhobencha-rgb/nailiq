import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

import { sendSmsReminder } from "@/shared/lib/twilioSms";

const salonId = "11111111-1111-4111-8111-111111111111";

function salonPolicyDb(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => result),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  return {
    from: vi.fn(() => builder),
    rpc: vi.fn(async (name: string) => {
      if (name === "claim_sms_delivery_attempt") {
        return {
          data: {
            success: true,
            code: "claimed",
            attempt_id: "22222222-2222-4222-8222-222222222222",
            attempt_token: ["7f4c5d6e", "8a9b", "4c1d", "b2e3", "4f5a6b7c8d9e"].join("-"),
          },
          error: null,
        };
      }
      return { data: { success: true, code: "completed" }, error: null };
    }),
  };
}

describe("SMS single dispatcher salon/A2P boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DISABLE_OUTBOUND_SMS", "");
    vi.stubEnv("DEMO_OTP", "");
    vi.stubEnv("NEXT_PUBLIC_DEMO_OTP", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("suppresses a US send before fetch when A2P is not registered", async () => {
    mocks.createServiceRoleClient.mockReturnValue(salonPolicyDb({
      data: { sms_outbound_enabled: true, sms_a2p_registered: false },
      error: null,
    }));
    const fetchSpy = vi.fn(() => {
      throw new Error("provider boundary must not be crossed");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await sendSmsReminder("+17145101234", "Booking confirmed", { salonId });

    expect(result).toMatchObject({
      ok: false,
      outcome: "suppressed",
      suppressed: true,
      suppressionReason: "a2p_not_registered",
      deliveryTruthPersisted: true,
    });
    expect(result.messageSid).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed as unknown before fetch when salon policy cannot be loaded", async () => {
    mocks.createServiceRoleClient.mockReturnValue(salonPolicyDb({
      data: null,
      error: { message: "policy unavailable" },
    }));
    const fetchSpy = vi.fn(() => {
      throw new Error("provider boundary must not be crossed");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await sendSmsReminder("+17145101234", "Booking confirmed", { salonId });

    expect(result).toMatchObject({
      ok: false,
      outcome: "rejected",
      error: "sms_policy_unavailable",
      deliveryTruthPersisted: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
