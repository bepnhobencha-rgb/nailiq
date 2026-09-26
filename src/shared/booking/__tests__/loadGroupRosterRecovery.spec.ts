import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadGroupRosterRecovery } from "../loadGroupRosterRecovery";

const now = new Date("2026-09-26T00:00:00Z");
const groups = new Map([["original", "group-a"]]);
const pending = { original_booking_id: "original", replacement_booking_id: null, group_id: "group-a", status: "pending", expires_at: "2026-09-27T00:00:00Z" };
const accepted = { ...pending, status: "accepted", replacement_booking_id: "replacement" };
const replacement = { id: "replacement", salon_id: "salon-a", group_id: "group-a", client_name: "Synthetic replacement", status: "confirmed", attendance_status: "confirmed" };

function fixture(rows: unknown[], bookings: unknown[] = [], error: unknown = null) {
  const calls: unknown[][] = [];
  const from = vi.fn((table: string) => {
    const chain = {
      select: (value: string) => { calls.push([table, "select", value]); return chain; },
      eq: (key: string, value: unknown) => { calls.push([table, "eq", key, value]); return chain; },
      in: (key: string, value: unknown) => { calls.push([table, "in", key, value]); return chain; },
      is: (key: string, value: unknown) => { calls.push([table, "is", key, value]); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: table === "bookings" ? bookings : rows, error })),
    };
    return chain;
  });
  return { db: { from } as unknown as Parameters<typeof loadGroupRosterRecovery>[0], from, calls };
}
afterEach(() => vi.unstubAllEnvs());
describe("tenant-bound read-only group roster recovery", () => {
  it("does not query any ledger with the flag off", async () => {
    vi.stubEnv("NAILIQ_GROUP_SLOT_RECOVERY", "false");
    const f = fixture([pending]);
    expect(await loadGroupRosterRecovery(f.db, "salon-a", groups, now)).toEqual(new Map());
    expect(f.from).not.toHaveBeenCalled();
  });
  it("scopes both ledger and replacement reads to salon and group", async () => {
    vi.stubEnv("NAILIQ_GROUP_SLOT_RECOVERY", "true");
    const f = fixture([accepted], [replacement]);
    expect((await loadGroupRosterRecovery(f.db, "salon-a", groups, now)).get("original")).toMatchObject({ status: "accepted", booking: replacement });
    for (const table of ["group_slot_replacements", "bookings"]) {
      expect(f.calls).toContainEqual([table, "eq", "salon_id", "salon-a"]);
      expect(f.calls).toContainEqual([table, "in", "group_id", ["group-a"]]);
    }
    expect(JSON.stringify(f.calls)).not.toMatch(/phone|token_hash|capability_id/);
  });
  it("does not label expired invitations as searching", async () => {
    vi.stubEnv("NAILIQ_GROUP_SLOT_RECOVERY", "true");
    const f = fixture([{ ...pending, expires_at: now.toISOString() }]);
    expect((await loadGroupRosterRecovery(f.db, "salon-a", groups, now)).size).toBe(0);
    expect(f.from).toHaveBeenCalledTimes(1);
  });
  it.each([
    [[{ ...accepted, group_id: "group-b" }], [replacement]],
    [[accepted], [{ ...replacement, salon_id: "salon-b" }]],
    [[accepted], [{ ...replacement, group_id: "group-b" }]],
    [[accepted], []],
    [[accepted, accepted], [replacement]],
    [[{ ...pending, expires_at: "invalid" }], []],
  ])("fails closed on inconsistent ledger or booking material", async (rows, bookings) => {
    vi.stubEnv("NAILIQ_GROUP_SLOT_RECOVERY", "true");
    const f = fixture(rows, bookings);
    await expect(loadGroupRosterRecovery(f.db, "salon-a", groups, now)).rejects.toThrow("group_roster_recovery_unavailable");
  });
  it("does not turn a database outage into an empty success", async () => {
    vi.stubEnv("NAILIQ_GROUP_SLOT_RECOVERY", "true");
    await expect(loadGroupRosterRecovery(fixture([], [], { message: "private db details" }).db, "salon-a", groups, now)).rejects.toThrow("group_roster_recovery_unavailable");
  });
});
