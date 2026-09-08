import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ session: vi.fn(), service: vi.fn(), audit: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/shared/auth/requireActiveSuperAdminSession", () => ({ requireActiveSuperAdminSession: mocks.session }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.service }));
vi.mock("@/shared/superadmin/audit", () => ({ writeAuditLog: mocks.audit }));
import { loadAllSalons, loadAllUsers, loadSalonDetail, loadPlatformFlags, loadPlatformSettings, updateSalonFlags, updatePlatformFlag, updatePlatformFeatureFlag, pauseSalonTenant, resumeSalonTenant, beginSalonPaymentGrace, restoreSalonRecord } from "../superadminActions";
import { loadAiCostDashboard } from "../aiCostActions";
import { SUPERADMIN_ROLES } from "@/shared/lib/superadmin";

import { triageErrorNow, draftFixNow, setErrorStatus } from "../errorMonitorActions";

const salonId = "11111111-1111-4111-8111-111111111111";
const mutations = [
  () => updateSalonFlags(salonId, { featureFlags: { group_booking_enabled: true } }),
  () => updatePlatformFlag("sms_outbound_enabled", true),
  () => updatePlatformFeatureFlag("group_booking", true),
  () => pauseSalonTenant(salonId, "manual", "QA"),
  () => resumeSalonTenant(salonId, "QA"),
  () => beginSalonPaymentGrace(salonId, 3, "QA"),
  () => restoreSalonRecord("services", salonId),
];
beforeEach(() => { vi.clearAllMocks(); });
describe("SuperAdmin actions enforce role authority before privileged data access", () => {
  for (const role of SUPERADMIN_ROLES) {
    if (role === "founder" || role === "ops_admin") continue;
    it(`${role} cannot mutate salon or platform settings`, async () => {
      mocks.session.mockResolvedValue({ ok: true, user: { id: "operator" }, role });
      for (const call of mutations) expect(await call()).toEqual({ ok: false, error: "forbidden" });
      for (const call of [() => triageErrorNow(salonId), () => draftFixNow(salonId), () => setErrorStatus(salonId, "ignored")]) expect(await call()).toEqual({ ok: false });
      expect(mocks.service).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    });
  }
  it("readonly analyst cannot read salon detail, users, flags, credentials or AI costs", async () => {
    mocks.session.mockResolvedValue({ ok: true, user: { id: "analyst" }, role: "readonly_analyst" });
    for (const call of [loadAllSalons, loadAllUsers, () => loadSalonDetail(salonId), loadPlatformFlags, loadPlatformSettings, loadAiCostDashboard]) expect((await call()).ok).toBe(false);
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it("revoked sessions stop before data access", async () => {
    mocks.session.mockResolvedValue({ ok: false, code: "session_revoked" });
    expect(await updateSalonFlags(salonId, {})).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.service).not.toHaveBeenCalled();
  });
});
