import type {
  ActivityItem,
  ActivityKind,
} from "@/shared/dashboard/loadActivityFeedAction";

export type ActivityFeedTab = ActivityKind | "all" | "cancelled";

export function activityItemsForTab(
  items: ActivityItem[],
  tab: ActivityFeedTab,
): ActivityItem[] {
  if (tab === "all") return items;
  if (tab === "cancelled") {
    return items.filter((item) => item.eventType === "booking_cancelled");
  }
  return items.filter((item) => item.kind === tab);
}

export function canOpenActivityBooking(item: ActivityItem): boolean {
  return Boolean(
    item.bookingId && item.eventType !== "booking_cancelled",
  );
}
