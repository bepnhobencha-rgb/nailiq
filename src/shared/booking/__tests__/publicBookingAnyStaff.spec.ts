import { describe, expect, it } from "vitest";

import { resolveAnyStaffForPublicBooking } from "@/shared/booking/publicBookingAnyStaff";

describe("Any-staff response-loss replay", () => {
  it("pins the quoted staff on an ambiguous retry and replays one committed row", () => {
    const rows = new Map<string, { id: string; staffId: string }>();
    let createCount = 0;
    const create = (key: string, staffId: string) => {
      const existing = rows.get(key);
      if (existing) return existing;
      createCount += 1;
      const row = { id: "booking-1", staffId };
      rows.set(key, row);
      return row;
    };

    const firstStaff = resolveAnyStaffForPublicBooking({
      mode: "submit",
      idempotencyReplay: false,
      quotedStaffId: "staff-a",
      freeStaffIds: ["staff-a", "staff-b"],
      pickFreeStaff: (ids) => ids[0] ?? null,
    });
    expect(firstStaff).toBe("staff-a");
    const committed = create("logical-key", firstStaff!);

    // The response is lost. The committed row now occupies staff-a, so a fresh
    // availability pass exposes only staff-b. The retry must still reach the DB
    // with staff-a and the same key, where it replays the existing booking.
    const retryStaff = resolveAnyStaffForPublicBooking({
      mode: "submit",
      idempotencyReplay: true,
      quotedStaffId: "staff-a",
      freeStaffIds: ["staff-b"],
      pickFreeStaff: (ids) => ids[0] ?? null,
    });
    const replay = create("logical-key", retryStaff!);

    expect(retryStaff).toBe("staff-a");
    expect(replay).toEqual(committed);
    expect(rows.size).toBe(1);
    expect(createCount).toBe(1);
  });

  it("does not pin an occupied quote on a known first attempt", () => {
    expect(resolveAnyStaffForPublicBooking({
      mode: "submit",
      idempotencyReplay: false,
      quotedStaffId: "staff-a",
      freeStaffIds: ["staff-b"],
      pickFreeStaff: (ids) => ids[0] ?? null,
    })).toBe("staff-b");
  });
});
