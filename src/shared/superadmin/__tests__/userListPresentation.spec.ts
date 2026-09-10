import { describe, expect, it } from "vitest";
import { presentUserList } from "../userListPresentation";
import type { SuperAdminUserRow } from "../superadminTypes";

const now = Date.parse("2026-09-10T12:00:00Z");
function user(age: number | null): SuperAdminUserRow {
  return {
    id: "qa-user", email: "qa@example.invalid", memberships: [],
    lastSignInAt: age === null ? null : new Date(now - age).toISOString(),
    createdAt: null,
  };
}

describe("server user-list snapshot", () => {
  it.each([
    [0, "Just now", "live"],
    [59_999, "Just now", "live"],
    [60_000, "1m ago", "live"],
    [719_999, "11m ago", "live"],
    [720_000, "12m ago", "live"],
    [899_999, "14m ago", "live"],
    [900_000, "15m ago", "today"],
    [3_599_999, "59m ago", "today"],
    [3_600_000, "1h ago", "today"],
    [86_399_999, "23h ago", "today"],
    [86_400_000, "1d ago", "week"],
    [604_799_999, "6d ago", "week"],
    [604_800_000, "7d ago", "dormant"],
    [null, "Never", "dormant"],
  ])("age %s has label %s and status %s", (age, activityLabel, activityStatus) => {
    expect(presentUserList([user(age)], now)[0]).toMatchObject({
      activityLabel, activityStatus, joinedLabel: "—",
    });
  });

  it("keeps source timestamps and memberships without mutating rows", () => {
    const source = user(719_999);
    const before = structuredClone(source);
    const row = presentUserList([source], now)[0];
    expect(source).toEqual(before);
    expect(row).not.toBe(source);
    expect(row).toMatchObject(source);
    // A later server snapshot, not a browser render, advances the display.
    expect(presentUserList([source], now + 1)[0].activityLabel).toBe("12m ago");
  });

  it("serializes absolute dates using the existing server locale convention", () => {
    const source = { ...user(40 * 86_400_000), createdAt: "2025-01-01T00:30:00Z" };
    const row = presentUserList([source], now)[0];
    expect(row.activityLabel).toBe(new Date(source.lastSignInAt!).toLocaleDateString("en-CA"));
    expect(row.joinedLabel).toBe(new Date(source.createdAt).toLocaleDateString("en-CA"));
  });

  it("handles an empty read", () => {
    expect(presentUserList([], now)).toEqual([]);
  });
});
