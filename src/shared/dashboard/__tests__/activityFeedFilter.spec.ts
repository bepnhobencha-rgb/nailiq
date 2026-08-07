import { describe, expect, it } from "vitest";

import {
  activityItemsForTab,
  canOpenActivityBooking,
} from "@/shared/dashboard/activityFeedFilter";
import type { ActivityItem } from "@/shared/dashboard/loadActivityFeedAction";

function item(input: Partial<ActivityItem> & Pick<ActivityItem, "id">): ActivityItem {
  return {
    kind: "event",
    when: "2026-08-06T12:00:00.000Z",
    title: "event",
    subtitle: null,
    status: null,
    actorRole: "owner",
    bookingId: null,
    bookingDate: null,
    transcript: null,
    ...input,
  };
}

describe("activity cancelled-history filter", () => {
  it("returns only durable booking cancellation events", () => {
    const cancelled = item({
      id: "cancelled",
      eventType: "booking_cancelled",
      bookingId: "booking-1",
    });
    const edited = item({
      id: "edited",
      eventType: "booking_edited",
      bookingId: "booking-2",
    });

    expect(activityItemsForTab([edited, cancelled], "cancelled")).toEqual([
      cancelled,
    ]);
  });

  it("does not send a terminal cancelled booking to the active schedule", () => {
    expect(canOpenActivityBooking(item({
      id: "cancelled",
      eventType: "booking_cancelled",
      bookingId: "booking-1",
    }))).toBe(false);
    expect(canOpenActivityBooking(item({
      id: "edited",
      eventType: "booking_edited",
      bookingId: "booking-2",
    }))).toBe(true);
  });
});
