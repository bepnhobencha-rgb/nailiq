import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), service: vi.fn(), preferredStaffId: "staff-b" }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/setupActions", () => ({ getDashboardWriteClient: mocks.context }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.service }));
vi.mock("@/shared/dashboard/salonVipStatus", () => ({ loadSalonVipProfileIds: async () => new Set() }));
vi.mock("@/shared/dashboard/salonClientName", () => ({ getSalonDisplayName: async () => null }));
vi.mock("@/shared/ai/usageLedger", () => ({ trackAnthropicFetch: vi.fn() }));
import { loadClientProfile360 } from "../loadClientProfile360Action";

function query(table: string) {
  const filters = new Map<string, unknown>();
  let single = false;
  const q = {
    select: vi.fn(() => q), is: vi.fn(() => q), not: vi.fn(() => q),
    order: vi.fn(() => q), limit: vi.fn(() => q),
    eq: vi.fn((key: string, value: unknown) => { filters.set(key, value); return q; }),
    maybeSingle: vi.fn(() => { single = true; return q; }),
    then: (resolve: (value: unknown) => unknown) => {
      let data: unknown = single ? null : [];
      if (table === "client_profiles") data = { id: "profile", name: "Synthetic guest", preferred_staff_id: mocks.preferredStaffId };
      if (table === "staff") {
        const staff = [{ id: "staff-a", salon_id: "salon-a", name: "QA Own Staff" }, { id: "staff-b", salon_id: "salon-b", name: "QA Foreign Staff" }];
        data = staff.find(row => [...filters].every(([k, v]) => row[k as keyof typeof row] === v)) ?? null;
      }
      return Promise.resolve({ data, error: null, count: 0 }).then(resolve);
    },
  };
  return q;
}
describe("Client360 preferred staff tenant boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.preferredStaffId = "staff-b";
    mocks.context.mockResolvedValue({ role: "owner", salon: { id: "salon-a" } });
    mocks.service.mockReturnValue({ from: vi.fn(query) });
  });
  it.each(["owner", "admin", "senior", "receptionist"])("%s never receives a preferred staff name from another salon", async role => {
    mocks.context.mockResolvedValue({ role, salon: { id: "salon-a" } });
    const r = await loadClientProfile360("qa-a", "16045550123");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.profile.preferredStaffName).toBeNull(); expect(JSON.stringify(r)).not.toContain("QA Foreign Staff"); }
  });
  it("preserves a preferred staff name belonging to the current salon", async () => {
    mocks.preferredStaffId = "staff-a";
    const r = await loadClientProfile360("qa-a", "16045550123");
    expect(r.ok).toBe(true); if (r.ok) expect(r.data.profile.preferredStaffName).toBe("QA Own Staff");
  });
  it.each(["nail_tech", "unknown", null])("denies role/context %s before privileged reads", async role => {
    mocks.context.mockResolvedValue(role ? { role, salon: { id: "salon-a" } } : null);
    expect(await loadClientProfile360("qa-a", "16045550123")).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.service).not.toHaveBeenCalled();
  });
});
