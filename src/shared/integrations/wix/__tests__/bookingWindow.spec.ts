import { describe, expect, it } from "vitest";

import { parseWixBookingWindow } from "@/shared/integrations/wix/bookingWindow";

describe("Wix inbound booking window", () => {
  it("canonicalizes provider offsets and preserves the exact duration", () => {
    expect(
      parseWixBookingWindow({
        startDate: "2026-11-01T01:30:00-07:00",
        endDate: "2026-11-01T02:00:00-08:00",
      }),
    ).toEqual({
      startUtc: "2026-11-01T08:30:00.000Z",
      endUtc: "2026-11-01T10:00:00.000Z",
      durationMinutes: 90,
    });
  });

  it("uses the complete slot window when top-level dates are absent", () => {
    expect(
      parseWixBookingWindow({
        slotStartDate: "2026-08-20T10:00:00Z",
        slotEndDate: "2026-08-20T10:45:00Z",
      }),
    ).toMatchObject({ durationMinutes: 45 });
  });

  it.each([
    { startDate: "2026-08-20T10:00:00Z" },
    { endDate: "2026-08-20T10:45:00Z" },
    { startDate: "2026-08-20T10:00:00", endDate: "2026-08-20T10:45:00Z" },
    { startDate: "2026-02-30T10:00:00Z", endDate: "2026-02-30T10:45:00Z" },
    { startDate: "2026-08-20T10:45:00Z", endDate: "2026-08-20T10:00:00Z" },
    { startDate: "2026-08-20T10:00:00Z", endDate: "2026-08-20T10:00:30Z" },
  ])("rejects incomplete or invalid windows without fabricating duration", (input) => {
    expect(parseWixBookingWindow(input)).toBeNull();
  });
});
