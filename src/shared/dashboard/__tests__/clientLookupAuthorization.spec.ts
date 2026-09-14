import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ context: vi.fn(), service: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/setupActions", () => ({ getDashboardWriteClient: mocks.context }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.service }));
vi.mock("@/shared/dashboard/salonVipStatus", () => ({ loadSalonVipProfileIds: vi.fn() }));
import { lookupClientByPhone } from "../lookupClientByPhoneAction";

describe("Phone lookup role boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.service.mockImplementation(() => { throw new Error("privileged read must not start"); });
  });
  for (const phone of ["16045550123", "bad-phone"]) {
    it.each(["nail_tech", "unknown", null, undefined])(`denies role %s before validation or privileged reads (${phone})`, async role => {
      mocks.context.mockResolvedValue({ role, salon: { id: "salon-a" } });
      expect(await lookupClientByPhone("qa-a", phone)).toEqual({ ok: false, error: "unauthorized" });
      expect(mocks.service).not.toHaveBeenCalled();
    });
  }
  it("rejects missing/revoked membership", async () => {
    mocks.context.mockResolvedValue(null);
    expect(await lookupClientByPhone("qa-a", "16045550123")).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it.each(["owner", "admin", "senior", "receptionist"])("retains validation for allowed %s", async role => {
    mocks.context.mockResolvedValue({ role, salon: { id: "salon-a" } });
    expect(await lookupClientByPhone("qa-a", "bad-phone")).toEqual({ ok: false, error: "invalid_phone" });
    expect(mocks.service).not.toHaveBeenCalled();
  });
});
