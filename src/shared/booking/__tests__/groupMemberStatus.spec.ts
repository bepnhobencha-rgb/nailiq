import { describe, expect, it } from "vitest";
import { groupMemberStatus, groupMemberCountsAsConfirmed, groupMemberHasActiveSlot, groupMemberIsReadOnly } from "../groupMemberStatus";
import { buildPartyCard, type RawClaim } from "@/shared/dashboard/partyCardHelpers";

describe("group member attendance truth", () => {
  it.each([
    [{ status: "confirmed", attendanceStatus: "pending" }, "pending"],
    [{ status: "pending", attendanceStatus: "confirmed" }, "pending"],
    [{ status: "confirmed", attendanceStatus: "confirmed" }, "confirmed"],
    [{ status: "cancelled", attendanceStatus: "confirmed" }, "cancelled"],
    [{ status: "confirmed", attendanceStatus: "declined" }, "declined"],
    [{ status: "completed", attendanceStatus: "confirmed" }, "completed"],
    [{ status: "no_show", attendanceStatus: "confirmed" }, "no_show"],
    [{}, "pending"],
  ] as const)("uses authoritative state %j", (input, expected) => {
    expect(groupMemberStatus(input)).toBe(expected);
  });

  it("counts pending replacement as held capacity, never as confirmed attendance", () => {
    const status = groupMemberStatus({ status: "confirmed", attendanceStatus: "confirmed", replacement: "pending" });
    expect(status).toBe("replacement_pending");
    expect(groupMemberHasActiveSlot(status)).toBe(true);
    expect(groupMemberCountsAsConfirmed(status)).toBe(false);
    expect(groupMemberIsReadOnly(status, "pending")).toBe(true);
  });

  it("accepted replacement does not override a later cancellation", () => {
    expect(groupMemberStatus({ status: "cancelled", attendanceStatus: "confirmed", replacement: "accepted" })).toBe("cancelled");
    expect(groupMemberStatus({ status: "confirmed", attendanceStatus: "confirmed", replacement: "accepted" })).toBe("replacement_confirmed");
  });

  function claim(status: string, attendance: string, price: number | null): RawClaim {
    return { id: status, booking_id: status, party_link_id: "party", member_name: "Synthetic", claimed_at: "2026-09-26T00:00:00Z", bookings: {
      start_time_utc: "2026-09-27T12:00:00Z", end_time_utc: "2026-09-27T13:00:00Z", price_cents: price,
      client_name: "Synthetic", wave_number: 1, status, attendance_status: attendance, services: { name: "Test" }, staff: { name: "Test" },
    } };
  }
  const link = { id: "party", group_id: "group", token: "private-link", mode: "sync_start", expires_at: "2026-10-01T00:00:00Z" };
  it("retains cancelled guest history without adding to revenue, attendance, or active count", () => {
    const card = buildPartyCard(link, [claim("confirmed", "confirmed", 12500), claim("cancelled", "confirmed", null), claim("confirmed", "pending", 5000)], "UTC", new Date("2026-09-26"));
    expect(card).toMatchObject({ totalSlots: 2, claimedCount: 1, pendingCount: 1, estimatedRevenueCents: 17500 });
    expect(card.slots).toHaveLength(3);
    expect(card.slots[1]).toMatchObject({ memberStatus: "cancelled", readOnly: true });
  });
  it("all cancelled group has zero active slots so the desk can omit it", () => {
    const card = buildPartyCard(link, [claim("cancelled", "confirmed", 12500)], "UTC", new Date("2026-09-26"));
    expect(card).toMatchObject({ totalSlots: 0, claimedCount: 0, pendingCount: 0, estimatedRevenueCents: null });
  });
  it("contact claim cannot become confirmed attendance", () => {
    const card = buildPartyCard(link, [claim("confirmed", "pending", 12500)], "UTC", new Date("2026-09-26"));
    expect(card.slots[0].claimed).toBe(true);
    expect(card.claimedCount).toBe(0);
  });
});
