import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { voiceBookingLogicalIdempotencyKey } from "@/shared/voiceai/voiceBookingIdempotency";

describe("Voice Any-staff logical idempotency", () => {
  it("keeps one key and one row when occupancy changes after a lost response", () => {
    const base = {
      sessionId: "call-1",
      salonId: "salon-1",
      serviceId: "service-1",
      requestedStaffId: "any",
      date: "2026-08-21",
      timeSlot: "2:00 PM",
      customerName: "Mai Tran",
      customerPhone: "16045551234",
    };
    const rows = new Map<string, { id: string; resolvedStaffId: string }>();
    let createCount = 0;
    const createOrReplay = (freeStaff: string[]) => {
      const key = voiceBookingLogicalIdempotencyKey(base);
      const replay = rows.get(key);
      if (replay) return replay;
      createCount += 1;
      const row = { id: "booking-1", resolvedStaffId: freeStaff[0]! };
      rows.set(key, row);
      return row;
    };

    const committed = createOrReplay(["staff-a", "staff-b"]);
    const retried = createOrReplay(["staff-b"]);

    expect(retried).toEqual(committed);
    expect(retried.resolvedStaffId).toBe("staff-a");
    expect(rows.size).toBe(1);
    expect(createCount).toBe(1);
    expect(voiceBookingLogicalIdempotencyKey(base)).toBe(
      voiceBookingLogicalIdempotencyKey({ ...base, requestedStaffId: "any" }),
    );
  });
});
