import { describe, expect, it } from "vitest";

import { buildOwnerHomeStaffSnapshot } from "@/shared/dashboard/ownerHomeStaffSnapshot";

const NOW = Date.parse("2026-07-30T20:00:00.000Z");

describe("buildOwnerHomeStaffSnapshot", () => {
  it("marks current and overrun service work busy while leaving idle staff available", () => {
    expect(
      buildOwnerHomeStaffSnapshot({
        nowMs: NOW,
        staff: [
          { id: "jenny", name: " Jenny " },
          { id: "mia", name: "Mia" },
          { id: "anna", name: "Anna" },
        ],
        bookings: [
          {
            staff_id: "jenny",
            status: "confirmed",
            start_time_utc: "2026-07-30T19:30:00.000Z",
            end_time_utc: "2026-07-30T20:30:00.000Z",
          },
          {
            staff_id: "mia",
            status: "in_progress",
            start_time_utc: "2026-07-30T18:00:00.000Z",
            end_time_utc: "2026-07-30T19:00:00.000Z",
          },
        ],
      }),
    ).toEqual([
      { name: "Jenny", status: "busy" },
      { name: "Mia", status: "busy" },
      { name: "Anna", status: "available" },
    ]);
  });

  it("does not mark future, completed, or another staff booking busy", () => {
    expect(
      buildOwnerHomeStaffSnapshot({
        nowMs: NOW,
        staff: [{ id: "jenny", name: "Jenny" }],
        bookings: [
          {
            staff_id: "jenny",
            status: "confirmed",
            start_time_utc: "2026-07-30T21:00:00.000Z",
            end_time_utc: "2026-07-30T22:00:00.000Z",
          },
          {
            staff_id: "jenny",
            status: "completed",
            start_time_utc: "2026-07-30T19:00:00.000Z",
            end_time_utc: "2026-07-30T20:30:00.000Z",
          },
          {
            staff_id: "other",
            status: "in_progress",
            start_time_utc: null,
            end_time_utc: null,
          },
        ],
      }),
    ).toEqual([{ name: "Jenny", status: "available" }]);
  });
});
