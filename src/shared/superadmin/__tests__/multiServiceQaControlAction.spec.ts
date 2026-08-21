import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getRole: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  requireActive: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/shared/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/lib/superadmin", () => ({
  getSuperAdminRole: mocks.getRole,
}));
vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({
  requireActiveSuperAdminSession: mocks.requireActive,
}));
vi.mock("@/shared/superadmin/audit", () => ({
  writeAuditLog: mocks.audit,
}));

import { configureMultiServiceBookingQaSalon } from "@/shared/superadmin/multiServiceQaControlAction";

const salonId = "11111111-1111-4111-8111-111111111111";
const enable = {
  salonId,
  confirmedSalonId: salonId,
  enable: true,
  confirmation: "ENABLE_MULTI_SERVICE_QA",
};

describe("configureMultiServiceBookingQaSalon", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "operator" } } });
    mocks.getRole.mockResolvedValue("founder");
    mocks.requireActive.mockResolvedValue({
      ok: true,
      user: { id: "operator" },
      role: "founder",
      supabase: {},
    });
    mocks.audit.mockResolvedValue(true);
  });

  it("rejects malformed or stale confirmation material before DB access", async () => {
    await expect(
      configureMultiServiceBookingQaSalon({ ...enable, confirmedSalonId: crypto.randomUUID() }),
    ).resolves.toEqual({ ok: false, error: "invalid_payload" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("allows only founder/ops and aborts when the audit boundary fails", async () => {
    mocks.requireActive.mockResolvedValueOnce({
      ok: true,
      user: { id: "operator" },
      role: "readonly_analyst",
      supabase: {},
    });
    await expect(configureMultiServiceBookingQaSalon(enable)).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.requireActive.mockResolvedValueOnce({
      ok: true,
      user: { id: "operator" },
      role: "ops_admin",
      supabase: {},
    });
    mocks.audit.mockResolvedValueOnce(false);
    await expect(configureMultiServiceBookingQaSalon(enable)).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("calls only the atomic controlled RPC with exact confirmation", async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: true, code: "enabled", salon_id: salonId, readiness: {} },
      error: null,
    });
    await expect(configureMultiServiceBookingQaSalon(enable)).resolves.toEqual({
      ok: true,
      salonId,
      enabled: true,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "configure_multi_service_booking_qa_salon",
      {
        p_salon_id: salonId,
        p_enable: true,
        p_confirmation: "ENABLE_MULTI_SERVICE_QA",
      },
    );
  });

  it("maps readiness rollback and non-QA rejection without retrying", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0001", message: "multi-service QA salon is not readiness-complete" },
    });
    await expect(configureMultiServiceBookingQaSalon(enable)).resolves.toEqual({
      ok: false,
      error: "not_ready",
    });
    mocks.rpc.mockResolvedValueOnce({
      data: { success: false, code: "salon_not_disposable_qa" },
      error: null,
    });
    await expect(configureMultiServiceBookingQaSalon(enable)).resolves.toEqual({
      ok: false,
      error: "salon_not_disposable_qa",
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
});
