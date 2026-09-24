import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), service: vi.fn(), preferredStaffId: "staff-b", tables: [] as string[], addon: 0, syncedSpend: 54321 as number | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/dashboard/setupActions", () => ({ getDashboardWriteClient: mocks.context }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.service }));
vi.mock("@/shared/dashboard/salonVipStatus", () => ({ loadSalonVipProfileIds: async () => new Set() }));
vi.mock("@/shared/dashboard/salonClientName", () => ({ getSalonDisplayName: async () => null }));
vi.mock("@/shared/ai/usageLedger", () => ({ trackAnthropicFetch: vi.fn() }));
import { loadClientProfile360, generateClient360Summary } from "../loadClientProfile360Action";

import { loadClientProfiles } from "../loadClientProfilesAction";
import { lookupClientByPhone } from "../lookupClientByPhoneAction";

function query(table: string) {
  mocks.tables.push(table);
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
      if (table === "bookings") data = [{ id: "b", start_time_utc: "2026-01-01T10:00:00Z", status: "completed", price_cents: 12345, addon_price_cents: mocks.addon }];
      if (table === "customer_booking_patterns") data = { usual_total_cents: 98765, recurring_weekday: 2 };
      if (table === "salon_client_spend") data = { total_spend_cents: mocks.syncedSpend };
      if (table === "client_ai_summaries") data = { summary_text: "PRIVATE SPEND", next_action: "PRIVATE ACTION", visit_count: 1, lang: "vi", computed_at: "2026-01-01" };
      if (table === "staff") {
        const staff = [{ id: "staff-a", salon_id: "salon-a", name: "QA Own Staff" }, { id: "staff-b", salon_id: "salon-b", name: "QA Foreign Staff" }];
        data = staff.find(row => [...filters].every(([k, v]) => row[k as keyof typeof row] === v)) ?? null;
      }
      return Promise.resolve({ data, error: null, count: 0 }).then(resolve);
    },
  };
  return q;
}
describe("Client spend authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.tables.length = 0; mocks.addon = 0; mocks.syncedSpend = 54321;
    mocks.context.mockResolvedValue({ role: "receptionist", salon: { id: "salon-a" } });
    mocks.service.mockReturnValue({ from: vi.fn(query), rpc: vi.fn(async () => ({ data: [{ phone: "16045550123", name: "Synthetic", total_spent_cents: 12345, visit_count: 1 }], error: null })) });
  });
  it("redacts receptionist spend/receipts/AI while retaining visit history", async () => {
    const r = await loadClientProfile360("qa-a", "16045550123"); expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.stats.lifetimeSpentCents).toBeNull();
      expect(r.data.stats.spendBasis).toBeNull();
      expect(r.data.stats.avgTicketCents).toBeNull();
      expect(r.data.timeline[0].priceCents).toBeNull();
      expect(r.data.stats.visitCount).toBe(1);
      expect(r.data.aiSummary).toBeNull();
      expect(r.data.pattern?.usualTotalCents).toBeNull();
      expect(r.data.pattern?.recurringWeekday).toBe(2);
      expect(mocks.tables).not.toContain("salon_client_spend");
      expect(mocks.tables).not.toContain("client_ai_summaries");
    }
  });
  it.each(["owner", "admin", "receptionist"])("returns the authorized salon timezone for %s without shifting stored instants", async role => {
    mocks.context.mockResolvedValue({ role, salon: { id: "salon-a", timezone: "America/Los_Angeles" } });
    const result = await loadClientProfile360("qa-a", "16045550123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.salonTimezone).toBe("America/Los_Angeles");
      expect(result.data.timeline[0].startUtc).toBe("2026-01-01T10:00:00Z");
    }
  });
  it("rejects a salon without authorized membership before privileged reads", async () => {
    mocks.context.mockResolvedValue(null);
    expect(await loadClientProfile360("other-salon", "16045550123")).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it.each(["owner", "admin", "senior"])("preserves financial profile for %s", async role => {
    mocks.context.mockResolvedValue({ role, salon: { id: "salon-a" } });
    const r = await loadClientProfile360("qa-a", "16045550123"); expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.stats.lifetimeSpentCents).toBe(54321); expect(r.data.stats.avgTicketCents).toBe(54321); expect(r.data.timeline[0].priceCents).toBe(12345); expect(r.data.aiSummary?.text).toBe("PRIVATE SPEND"); }
  });
  it.each(["receptionist", "nail_tech", "unknown"])("blocks direct financial AI generation for %s before DB/provider", async role => {
    mocks.context.mockResolvedValue({ role, salon: { id: "salon-a" } });
    expect(await generateClient360Summary("qa-a", "16045550123")).toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it.each(["owner", "admin", "senior"])("includes add-ons in booking-value fallback for %s without inventing payment", async role => {
    mocks.context.mockResolvedValue({ role, salon: { id: "salon-a" } });
    mocks.addon = 1000; mocks.syncedSpend = null;
    const result = await loadClientProfile360("qa-a", "16045550123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stats.lifetimeSpentCents).toBe(13345);
      expect(result.data.stats.spendBasis).toBe("completed_service_value");
      expect(result.data.stats.avgTicketCents).toBe(13345);
      expect(result.data.timeline[0].priceCents).toBe(13345);
    }
  });
  it("keeps synced payments separate from booking value with add-ons", async () => {
    mocks.context.mockResolvedValue({ role: "owner", salon: { id: "salon-a" } });
    mocks.addon = 1000;
    const result = await loadClientProfile360("qa-a", "16045550123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stats.lifetimeSpentCents).toBe(54321);
      expect(result.data.stats.spendBasis).toBe("synced_payments");
      expect(result.data.timeline[0].priceCents).toBe(13345);
    }
  });
  it.each(["owner", "admin", "senior", "receptionist"])("projects directory and phone lookup spend for %s", async role => {
    mocks.context.mockResolvedValue({ role, salon: { id: "salon-a" } });
    const directory = await loadClientProfiles("qa-a"); expect(directory.ok).toBe(true);
    if (directory.ok) expect(directory.clients[0].totalSpentCents).toBe(role === "receptionist" ? null : 12345);
    const lookup = await lookupClientByPhone("qa-a", "16045550123"); expect(lookup.ok).toBe(true);
    if (lookup.ok && lookup.found) expect(lookup.profile.total_spent_cents).toBe(role === "receptionist" ? null : 12345);
    else throw Error("Expected known client");
  });
});
