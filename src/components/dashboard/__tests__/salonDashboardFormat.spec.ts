import { describe, expect, it } from "vitest";

import {
  groupUpcomingBookingsBySalonDay,
  splitSalonDashboardBookings,
} from "../salonDashboardFormat";
import type { SalonDashboardBooking } from "@/shared/types";

function booking(
  id: string,
  start_time_utc: string,
  status: SalonDashboardBooking["status"] = "confirmed",
): SalonDashboardBooking {
  return {
    id,
    client_name: id,
    client_phone: null,
    client_notes: null,
    start_time_utc,
    status,
    source: "appointment",
    service_name: "Manicure",
    staff_name: null,
    price_cents: 2500,
    verification_method: null,
    sms_confirmation_sent_at: null,
    sms_confirmation_failed_at: null,
    no_show_risk_score: null,
    seat_together: false,
  };
}

describe("owner dashboard salon-day boundaries", () => {
  it("uses the salon day instead of the server UTC day for today and upcoming", () => {
    const rows = [
      booking("today", "2026-07-08T00:30:00.000Z"),
      booking("tomorrow", "2026-07-08T07:30:00.000Z"),
    ];

    const result = splitSalonDashboardBookings(
      rows,
      "America/Los_Angeles",
      "2026-07-08T01:00:00.000Z",
    );

    expect(result.today.map((row) => row.id)).toEqual(["today"]);
    expect(result.upcoming.map((row) => row.id)).toEqual(["tomorrow"]);
  });

  it("groups UTC instants by the explicit salon timezone", () => {
    const rows = [
      booking("late-july-7", "2026-07-08T00:30:00.000Z"),
      booking("early-july-8", "2026-07-08T07:30:00.000Z"),
    ];

    const groups = groupUpcomingBookingsBySalonDay(
      rows,
      "America/Los_Angeles",
      "en-US",
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.items.map((row) => row.id))).toEqual([
      ["late-july-7"],
      ["early-july-8"],
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Tue, Jul 7",
      "Wed, Jul 8",
    ]);
  });

  it("falls back to UTC for an invalid stored timezone", () => {
    const rows = [booking("safe", "2026-07-08T00:30:00.000Z")];

    expect(
      groupUpcomingBookingsBySalonDay(rows, "Mars/Olympus", "en-US")[0]
        ?.label,
    ).toBe("Wed, Jul 8");
  });
});
