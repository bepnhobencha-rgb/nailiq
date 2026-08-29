import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  requireActive: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({
  requireActiveSuperAdminSession: mocks.requireActive,
}));
vi.mock("@/shared/superadmin/audit", () => ({
  writeAuditLog: mocks.audit,
}));

import { configureMultiServiceBookingRollout } from "@/shared/superadmin/multiServiceRolloutControlAction";

const salonId = "11111111-1111-4111-8111-111111111111";
const enable = {
  salonId,
  confirmedSalonId: salonId,
  enable: true,
  confirmation: "ENABLE_MULTI_SERVICE_PRODUCTION",
};

describe("configureMultiServiceBookingRollout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActive.mockResolvedValue({
      ok: true,
      user: { id: "22222222-2222-4222-8222-222222222222" },
      role: "founder",
      supabase: {},
    });
    mocks.audit.mockResolvedValue(true);
  });

  it("rejects malformed or mismatched confirmation before DB access", async () => {
    await expect(
      configureMultiServiceBookingRollout({
        ...enable,
        confirmedSalonId: crypto.randomUUID(),
      }),
    ).resolves.toEqual({ ok: false, error: "invalid_payload" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("permits only founder/ops and requires a durable audit first", async () => {
    mocks.requireActive.mockResolvedValueOnce({
      ok: true,
      user: { id: "22222222-2222-4222-8222-222222222222" },
      role: "readonly_analyst",
      supabase: {},
    });
    await expect(configureMultiServiceBookingRollout(enable)).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.audit.mockResolvedValueOnce(false);
    await expect(configureMultiServiceBookingRollout(enable)).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("calls only the atomic controlled RPC with actor and exact confirmation", async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "enabled", salon_id: salonId, readiness: {} },
      error: null,
    });
    await expect(configureMultiServiceBookingRollout(enable)).resolves.toEqual({
      ok: true,
      salonId,
      enabled: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "configure_multi_service_booking_rollout",
      {
        p_salon_id: salonId,
        p_enable: true,
        p_confirmation: "ENABLE_MULTI_SERVICE_PRODUCTION",
        p_actor_user_id: "22222222-2222-4222-8222-222222222222",
      },
    );
  });

  it("surfaces platform, active-subscription, and readiness blockers without retry", async () => {
    for (const code of [
      "platform_disabled",
      "salon_not_active",
      "not_ready",
    ] as const) {
      mocks.rpc.mockResolvedValueOnce({
        data: { success: false, code },
        error: null,
      });
      await expect(configureMultiServiceBookingRollout(enable)).resolves.toEqual({
        ok: false,
        error: code,
      });
    }
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });
});
