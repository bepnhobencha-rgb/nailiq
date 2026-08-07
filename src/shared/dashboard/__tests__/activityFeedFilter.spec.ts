import { describe, expect, it } from "vitest";

import {
  activityItemsForTab,
  canOpenActivityBooking,
  terminalActivityBookingStatus,
} from "@/shared/dashboard/activityFeedFilter";
import type { ActivityItem } from "@/shared/dashboard/loadActivityFeedAction";

function item(
  input: Partial<ActivityItem> & Pick<ActivityItem, "id">,
): ActivityItem {
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

  it("opens terminal bookings only when archived recovery is enabled", () => {
    const cancelled = item({
      id: "cancelled",
      eventType: "booking_cancelled",
      bookingId: "booking-1",
    });
    const noShow = item({
      id: "no-show",
      bookingId: "booking-3",
      bookingStatus: "no_show",
    });

    expect(canOpenActivityBooking(cancelled, false)).toBe(false);
    expect(canOpenActivityBooking(cancelled, true)).toBe(true);
    expect(canOpenActivityBooking(noShow, false)).toBe(false);
    expect(canOpenActivityBooking(noShow, true)).toBe(true);
    expect(terminalActivityBookingStatus(noShow)).toBe("no_show");
  });

  it("keeps an active booking link available independently of recovery", () => {
    expect(
      canOpenActivityBooking(
        item({
          id: "edited",
          eventType: "booking_edited",
          bookingId: "booking-2",
        }),
        false,
      ),
    ).toBe(true);
  });

  it("does not treat a legacy cancellation event as archived after the joined booking was restored", () => {
    const restored = item({
      id: "legacy-restored",
      eventType: "booking_cancelled",
      bookingId: "booking-restored",
      bookingStatus: null,
      bookingStatusKnown: true,
    });

    expect(terminalActivityBookingStatus(restored)).toBeNull();
    expect(canOpenActivityBooking(restored, false)).toBe(true);
    expect(activityItemsForTab([restored], "cancelled")).toEqual([]);
  });

  it("does not duplicate status-derived rows in the cancelled tab", () => {
    const cancelled = item({
      id: "status-cancelled",
      bookingId: "booking-4",
      bookingStatus: "cancelled",
    });
    expect(activityItemsForTab([cancelled], "cancelled")).toEqual([]);
  });

  it("shows only the explicit no-show transition in the no-show tab", () => {
    const transition = item({
      id: "no-show-transition",
      eventType: "booking_status_changed",
      terminalEventStatus: "no_show",
      bookingStatus: "no_show",
    });
    const notification = item({
      id: "notification-for-current-no-show",
      kind: "sms",
      bookingStatus: "no_show",
    });
    expect(activityItemsForTab([notification, transition], "no_show")).toEqual([
      transition,
    ]);
  });
});
