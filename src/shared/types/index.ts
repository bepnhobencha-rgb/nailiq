export type BookingStatus =
  | "pending"
  | "confirmed"
  | "completed"
  | "waiting"
  | "in_progress"
  | "cancelled";

export type BookingSource = "appointment" | "walkin";

export {
  QUEUE_SOURCES,
  QUEUE_PRIORITIES,
  QUEUE_REQUEST_TAG_MAX_LEN,
  QUEUE_REQUEST_TAGS_MAX_COUNT,
  isQueueSource,
  isQueuePriority,
  normalizeRequestTag,
  parseRequestTags,
} from "./queue";
export type {
  QueueSource,
  QueuePriority,
  QueueRequestTag,
} from "./queue";

/** Statuses shown in the owner “today” list (excludes queue-only, finished, cancelled). */
export const OWNER_TODAY_LIST_STATUSES: BookingStatus[] = [
  "pending",
  "confirmed",
  "in_progress",
];

/** Statuses loaded for the owner dashboard grid, stats, and upcoming (excludes walk-in queue + cancelled). */
export const ACTIVE_GRID_STATUSES: BookingStatus[] = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
];

export type SalonDashboardBooking = {
  id: string;
  client_name: string;
  client_phone: string | null;
  /** Guest notes from public booking when provided. */
  client_notes: string | null;
  /** Null for walk-in rows before a slot exists. */
  start_time_utc: string | null;
  status: BookingStatus;
  source: BookingSource;
  service_name: string;
  /** Assigned staff display name when present. */
  staff_name: string | null;
  price_cents: number;
};
