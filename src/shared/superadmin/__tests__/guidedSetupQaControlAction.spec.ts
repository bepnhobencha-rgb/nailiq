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

import { configureGuidedSetupQaSalon } from "@/shared/superadmin/guidedSetupQaControlAction";

const salonId = "11111111-1111-4111-8111-111111111111";
const enable = {
  salonId,
  confirmedSalonId: salonId,
  enable: true,
  confirmation: "ENABLE_GUIDED_ADMIN_SETUP_QA",
};

describe("configureGuidedSetupQaSalon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActive.mockResolvedValue({
      ok: true,
      user: { id: "operator" },
      role: "founder",
      supabase: {},
    });
    mocks.audit.mockResolvedValue(true);
  });

  it("rejects malformed, cross-salon, and stale confirmation before DB access", async () => {
    await expect(
      configureGuidedSetupQaSalon({
        ...enable,
        confirmedSalonId: "22222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toEqual({ ok: false, error: "invalid_payload" });
    await expect(
      configureGuidedSetupQaSalon({
        ...enable,
        confirmation: "ENABLE_GUIDED_SETUP_QA",
      }),
    ).resolves.toEqual({ ok: false, error: "invalid_payload" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("permits only active founder/ops and requires the audit write first", async () => {
    mocks.requireActive.mockResolvedValueOnce({
      ok: true,
      user: { id: "operator" },
      role: "readonly_analyst",
      supabase: {},
    });
    await expect(configureGuidedSetupQaSalon(enable)).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    mocks.requireActive.mockResolvedValueOnce({
      ok: true,
      user: { id: "operator" },
      role: "ops_admin",
      supabase: {},
    });
    mocks.audit.mockResolvedValueOnce(false);
    await expect(configureGuidedSetupQaSalon(enable)).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("calls only the atomic allowlist RPC with exact confirmed material", async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "enabled", salon_id: salonId },
      error: null,
    });
    await expect(configureGuidedSetupQaSalon(enable)).resolves.toEqual({
      ok: true,
      salonId,
      enabled: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "configure_guided_admin_setup_qa_salon",
      {
        p_salon_id: salonId,
        p_enable: true,
        p_confirmation: "ENABLE_GUIDED_ADMIN_SETUP_QA",
      },
    );
    expect(mocks.audit).toHaveBeenCalledBefore(mocks.rpc);
  });

  it.each([
    "not_found",
    "platform_disabled",
    "allowlist_conflict",
    "salon_not_disposable_qa",
  ] as const)("maps the terminal DB code %s without retry", async (code) => {
    mocks.rpc.mockResolvedValue({
      data: { success: false, code },
      error: null,
    });
    await expect(configureGuidedSetupQaSalon(enable)).resolves.toEqual({
      ok: false,
      error: code,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
