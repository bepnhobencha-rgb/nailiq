import type { ActivityItem } from "./loadActivityFeedAction";

const str = (value: unknown): string => value == null ? "" : String(value);

/** Convert a durable AI Receptionist escalation into the owner-visible
 * Activity feed shape. Kept pure so the persistence → dashboard contract has a
 * focused regression test without needing a live database. */
export function customerMessageActivityItem(
  row: Record<string, unknown>,
): ActivityItem {
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload as Record<string, unknown>
    : {};
  const name = str(payload.customer_name).trim() || "khách";
  const phone = str(payload.customer_phone).trim();
  const message = str(payload.message).trim();
  const urgent = str(payload.urgency) === "urgent";
  const details = [
    `Khách: ${name}`,
    ...(phone ? [`SĐT: ${phone}`] : []),
    "",
    message || "(Không có nội dung)",
  ].join("\n");

  return {
    id: `msg-${str(row.id)}`,
    kind: "ai",
    when: str(row.created_at),
    title: `${urgent ? "🔴 " : "📨 "}Lời nhắn khách qua AI Tiếp tân · ${name}`,
    subtitle: message || null,
    status: "saved",
    actorRole: null,
    bookingId: null,
    bookingDate: null,
    transcript: details,
  };
}
