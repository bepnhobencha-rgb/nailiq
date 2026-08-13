import type {
  ActivityItem,
  ActivityKind,
} from "@/shared/dashboard/loadActivityFeedAction";

export type ActivityFeedTab = ActivityKind | "all" | "cancelled" | "no_show";
export type TerminalActivityBookingStatus = "cancelled" | "no_show";

export function terminalActivityBookingStatus(
  item: ActivityItem,
): TerminalActivityBookingStatus | null {
  return item.bookingStatus === "cancelled" || item.bookingStatus === "no_show"
    ? item.bookingStatus
    : item.bookingStatusKnown
      ? null
      : item.eventType === "booking_cancelled"
      ? "cancelled"
      : null;
}

export function activityItemsForTab(
  items: ActivityItem[],
  tab: ActivityFeedTab,
): ActivityItem[] {
  if (tab === "all") return items;
  if (tab === "cancelled") {
    return items.filter(
      (item) =>
        item.eventType === "booking_cancelled" &&
        terminalActivityBookingStatus(item) === "cancelled",
    );
  }
  if (tab === "no_show") {
    return items.filter(
      (item) =>
        item.eventType === "booking_status_changed" &&
        item.terminalEventStatus === "no_show" &&
        terminalActivityBookingStatus(item) === "no_show",
    );
  }
  return items.filter((item) => item.kind === tab);
}

export function canOpenActivityBooking(item: ActivityItem): boolean {
  if (!item.bookingId) return false;
  // Terminal history is always read-only and visible to the already-gated
  // owner/admin Activity page. The recovery flag controls only the optional
  // create-a-linked-replacement CTA inside the drawer; it must never hide the
  // source record itself.
  return true;
}
